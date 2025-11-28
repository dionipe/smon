const express = require('express');
const path = require('path');
const fs = require('fs');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const snmp = require('net-snmp');
const ping = require('ping');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const os = require('os');

const app = express();
const port = 3000;

// Vendor OID mappings for different network device vendors
const VENDOR_OIDS = {
  // Standard MIB-II (works on most devices)
  standard: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',      // Interface description
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',  // Inbound octets
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16', // Outbound octets
    sysDescr: '1.3.6.1.2.1.1.1.0',        // System description
    cpuUsage: '1.3.6.1.4.1.2021.11.9.0'   // UCD-SNMP-MIB CPU usage (percentage)
  },
  // Cisco specific OIDs
  cisco: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    sysDescr: '1.3.6.1.2.1.1.1.0',
    // Cisco specific counters (64-bit)
    ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',  // High capacity in octets
    ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10', // High capacity out octets
    // Cisco CPU usage
    cpmCPUTotal5sec: '1.3.6.1.4.1.9.9.109.1.1.1.1.5.1', // Cisco CPU total 5sec
    cpmCPUTotal1min: '1.3.6.1.4.1.9.9.109.1.1.1.1.6.1'   // Cisco CPU total 1min
  },
  // Huawei specific OIDs
  huawei: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    sysDescr: '1.3.6.1.2.1.1.1.0',
    // Huawei specific counters
    hwIfInOctets: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.6',  // Huawei interface in octets
    hwIfOutOctets: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.10', // Huawei interface out octets
    // Huawei CPU usage
    hwEntityCpuUsage: '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.6' // Huawei entity CPU usage
  },
  // Mikrotik specific OIDs
  mikrotik: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    sysDescr: '1.3.6.1.2.1.1.1.0',
    // Mikrotik specific counters
    mtxrIfInOctets: '1.3.6.1.4.1.14988.1.1.14.1.1.6',  // Mikrotik interface in octets
    mtxrIfOutOctets: '1.3.6.1.4.1.14988.1.1.14.1.1.10', // Mikrotik interface out octets
    // Mikrotik CPU usage
    mtxrCpuLoad: '1.3.6.1.4.1.14988.1.1.3.11.0' // Mikrotik CPU load
  },
  // Juniper specific OIDs
  juniper: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    sysDescr: '1.3.6.1.2.1.1.1.0',
    // Juniper specific counters
    jnxIfInOctets: '1.3.6.1.4.1.2636.3.3.1.1.7',  // Juniper interface in octets
    jnxIfOutOctets: '1.3.6.1.4.1.2636.3.3.1.1.11', // Juniper interface out octets
    // Juniper CPU usage
    jnxOperatingCPU: '1.3.6.1.4.1.2636.4.16.1.4.1.1.1' // Juniper operating CPU
  },
  // HP/Aruba specific OIDs
  hp: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    sysDescr: '1.3.6.1.2.1.1.1.0',
    // HP specific counters
    hpIfInOctets: '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.6',  // HP interface in octets
    hpIfOutOctets: '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.10', // HP interface out octets
    // HP CPU usage
    hpCpuUtilization: '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.4' // HP CPU utilization
  }
};

// Function to detect device vendor based on sysDescr
function detectVendor(sysDescr) {
  const descr = sysDescr.toLowerCase();
  
  if (descr.includes('cisco')) return 'cisco';
  if (descr.includes('huawei')) return 'huawei';
  if (descr.includes('mikrotik') || descr.includes('routeros')) return 'mikrotik';
  if (descr.includes('juniper') || descr.includes('junos')) return 'juniper';
  if (descr.includes('hp') || descr.includes('aruba') || descr.includes('procurve')) return 'hp';
  
  return 'standard'; // Default to standard MIB-II
}

// Function to get appropriate OID for vendor and metric
function getVendorOID(vendor, metric) {
  const vendorConfig = VENDOR_OIDS[vendor] || VENDOR_OIDS.standard;
  return vendorConfig[metric] || VENDOR_OIDS.standard[metric];
}

// Function to get CPU OID for vendor (handles different metric names)
function getCpuOID(vendor) {
  const vendorConfig = VENDOR_OIDS[vendor] || VENDOR_OIDS.standard;

  // Try vendor-specific CPU metrics first
  switch (vendor) {
    case 'cisco':
      return vendorConfig['cpmCPUTotal5sec'] || vendorConfig['cpmCPUTotal1min'];
    case 'huawei':
      return vendorConfig['hwEntityCpuUsage'];
    case 'mikrotik':
      return vendorConfig['mtxrCpuLoad'];
    case 'juniper':
      return vendorConfig['jnxOperatingCPU'];
    case 'hp':
      return vendorConfig['hpCpuUtilization'];
    default:
      return vendorConfig['cpuUsage']; // Standard UCD-SNMP
  }
}

// Function to process RX data
function processRxData(deviceId, device, iface, rxValue, timestamp = new Date()) {
  try {
    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const rxPoint = new Point('snmp_metric')
      .tag('device', deviceId)
      .tag('device_name', device.name)
      .tag('interface', iface.name)
      .tag('direction', 'rx')
      .tag('vendor', device.vendor || 'standard')
      .timestamp(timestamp)
      .floatField('value', rxValue);
    writeApi.writePoint(rxPoint);
    writeApi.close().then(() => {
      console.log(`[${deviceId}] RX data written for ${iface.name}`);
    }).catch(err => {
      console.error('InfluxDB RX write error:', err);
    });
  } catch (err) {
    console.error('Error creating RX write API:', err);
  }
}

// Function to process TX data
function processTxData(deviceId, device, iface, txValue, timestamp = new Date()) {
  try {
    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const txPoint = new Point('snmp_metric')
      .tag('device', deviceId)
      .tag('device_name', device.name)
      .tag('interface', iface.name)
      .tag('direction', 'tx')
      .tag('vendor', device.vendor || 'standard')
      .timestamp(timestamp)
      .floatField('value', txValue);
    writeApi.writePoint(txPoint);
    writeApi.close().then(() => {
      console.log(`[${deviceId}] TX data written for ${iface.name}`);
    }).catch(err => {
      console.error('InfluxDB TX write error:', err);
    });
  } catch (err) {
    console.error('Error creating TX write API:', err);
  }
}

// Function to process CPU data
function processCpuData(deviceId, device, cpuValue, timestamp = new Date()) {
  try {
    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const cpuPoint = new Point('snmp_metric')
      .tag('device', deviceId)
      .tag('device_name', device.name)
      .tag('metric', 'cpu')
      .tag('vendor', device.vendor || 'standard')
      .timestamp(timestamp)
      .floatField('value', cpuValue);
    writeApi.writePoint(cpuPoint);
    writeApi.close().then(() => {
      console.log(`[${deviceId}] CPU data written: ${cpuValue}%`);
      
      // Send high CPU notification if enabled
      notifyHighCpu(deviceId, device.name, cpuValue);
    }).catch(err => {
      console.error('InfluxDB CPU write error:', err);
    });
  } catch (err) {
    console.error('Error creating CPU write API:', err);
  }
}

// Telegram notification functions
function sendTelegramMessage(message) {
  if (!telegramBot || !settings.telegram || !settings.telegram.enabled || !settings.telegram.chatId) {
    return;
  }

  try {
    telegramBot.sendMessage(settings.telegram.chatId, message, { parse_mode: 'HTML' })
      .then(() => {
        console.log('[TELEGRAM] Message sent successfully');
      })
      .catch(error => {
        console.error('[TELEGRAM] Failed to send message:', error.message);
      });
  } catch (error) {
    console.error('[TELEGRAM] Error sending message:', error.message);
  }
}

function notifyDeviceStatus(deviceId, deviceName, status, details = '') {
  // Record the transition for flapping detection
  recordDeviceTransition(deviceId, status);

  // Check if device is flapping and suppress notifications if configured
  if (settings.flapping && settings.flapping.enabled && settings.flapping.suppressNotifications) {
    if (isDeviceFlapping(deviceId)) {
      console.log(`[${deviceId}] Suppressing ${status} notification - device is flapping`);
      return;
    }
  }

  if (!settings.telegram || !settings.telegram.enabled) return;

  const timestamp = new Date().toLocaleString('id-ID');
  let message = '';

  if (status === 'up' && settings.telegram.notifyOnDeviceUp) {
    message = `🟢 <b>Device UP</b>\n\n` +
              `📍 <b>Device:</b> ${deviceName} (${deviceId})\n` +
              `⏰ <b>Time:</b> ${timestamp}\n` +
              `📊 <b>Status:</b> Device is now online\n` +
              (details ? `ℹ️ <b>Details:</b> ${details}` : '');
  } else if (status === 'down' && settings.telegram.notifyOnDeviceDown) {
    message = `🔴 <b>Device DOWN</b>\n\n` +
              `📍 <b>Device:</b> ${deviceName} (${deviceId})\n` +
              `⏰ <b>Time:</b> ${timestamp}\n` +
              `📊 <b>Status:</b> Device is offline\n` +
              (details ? `ℹ️ <b>Details:</b> ${details}` : '');
  }

  if (message) {
    sendTelegramMessage(message);
    notifyDeviceStatusEmail(deviceId, deviceName, status, details);
  }
}

function notifyHighCpu(deviceId, deviceName, cpuValue) {
  if (!settings.telegram || !settings.telegram.enabled || !settings.telegram.notifyOnHighCpu) return;

  const threshold = settings.telegram.cpuThreshold || 80;
  if (cpuValue >= threshold) {
    const timestamp = new Date().toLocaleString('id-ID');
    const message = `⚠️ <b>High CPU Usage Alert</b>\n\n` +
                    `📍 <b>Device:</b> ${deviceName} (${deviceId})\n` +
                    `⏰ <b>Time:</b> ${timestamp}\n` +
                    `📊 <b>CPU Usage:</b> ${cpuValue}%\n` +
                    `🎯 <b>Threshold:</b> ${threshold}%\n` +
                    `🚨 <b>Status:</b> CPU usage is above threshold!`;

    sendTelegramMessage(message);
    notifyHighCpuEmail(deviceId, deviceName, cpuValue);
    
    // Log high CPU event
    logEvent('high_cpu', 'warning', deviceName, `Device "${deviceName}" has high CPU usage: ${cpuValue}% (threshold: ${threshold}%)`, {
      deviceId: deviceId,
      deviceName: deviceName,
      cpuValue: cpuValue,
      threshold: threshold
    });
  }
}

function notifyPingStatus(targetId, targetName, targetHost, status, latency = null, packetLoss = null) {
  // Record the transition for flapping detection
  recordPingTransition(targetId, status);

  // Check if ping target is flapping and suppress notifications if configured
  if (settings.flapping && settings.flapping.enabled && settings.flapping.suppressNotifications) {
    if (isPingFlapping(targetId)) {
      console.log(`[PING-${targetId}] Suppressing ${status} notification - target is flapping`);
      return;
    }
  }

  if (!settings.telegram || !settings.telegram.enabled) return;

  const timestamp = new Date().toLocaleString('id-ID');
  let message = '';
  let shouldNotify = false;

  if (status === 'down' && settings.telegram.notifyOnPingDown) {
    message = `🔴 <b>Ping Target Down Alert</b>\n\n` +
              `📍 <b>Target:</b> ${targetName} (${targetHost})\n` +
              `⏰ <b>Time:</b> ${timestamp}\n` +
              `❌ <b>Status:</b> Target is unreachable\n` +
              `📊 <b>Packet Loss:</b> 100%\n` +
              `🚨 <b>Alert:</b> Ping target is down!`;
    shouldNotify = true;
    
    // Log ping down event
    logEvent('ping_down', 'error', targetName, `Ping target "${targetName}" (${targetHost}) is down`, {
      targetId: targetId,
      targetName: targetName,
      host: targetHost,
      packetLoss: packetLoss || 100
    });
  } else if (status === 'up' && settings.telegram.notifyOnPingUp) {
    message = `🟢 <b>Ping Target Up Alert</b>\n\n` +
              `📍 <b>Target:</b> ${targetName} (${targetHost})\n` +
              `⏰ <b>Time:</b> ${timestamp}\n` +
              `✅ <b>Status:</b> Target is back online\n` +
              `📊 <b>Latency:</b> ${latency}ms\n` +
              `📊 <b>Packet Loss:</b> ${packetLoss}%\n` +
              `🎉 <b>Alert:</b> Ping target recovered!`;
    shouldNotify = true;
    
    // Log ping up event
    logEvent('ping_up', 'info', targetName, `Ping target "${targetName}" (${targetHost}) is back online`, {
      targetId: targetId,
      targetName: targetName,
      host: targetHost,
      latency: latency,
      packetLoss: packetLoss
    });
  } else if (status === 'timeout' && settings.telegram.notifyOnPingTimeout) {
    message = `⏰ <b>Ping Timeout Alert</b>\n\n` +
              `📍 <b>Target:</b> ${targetName} (${targetHost})\n` +
              `⏰ <b>Time:</b> ${timestamp}\n` +
              `⏳ <b>Status:</b> Ping request timed out\n` +
              `📊 <b>Packet Loss:</b> 100%\n` +
              `🚨 <b>Alert:</b> Ping timeout detected!`;
    shouldNotify = true;
    
    // Log ping timeout event
    logEvent('ping_timeout', 'warning', targetName, `Ping target "${targetName}" (${targetHost}) timed out`, {
      targetId: targetId,
      targetName: targetName,
      host: targetHost,
      packetLoss: 100
    });
  } else if (status === 'high_latency' && settings.telegram.notifyOnPingHighLatency && latency !== null) {
    const threshold = settings.telegram.pingLatencyThreshold || 50;
    if (latency >= threshold) {
      message = `🐌 <b>High Ping Latency Alert</b>\n\n` +
                `📍 <b>Target:</b> ${targetName} (${targetHost})\n` +
                `⏰ <b>Time:</b> ${timestamp}\n` +
                `📊 <b>Latency:</b> ${latency}ms\n` +
                `🎯 <b>Threshold:</b> ${threshold}ms\n` +
                `📊 <b>Packet Loss:</b> ${packetLoss}%\n` +
                `🚨 <b>Alert:</b> Ping latency is above threshold!`;
      shouldNotify = true;
      
      // Log high latency event
      logEvent('high_latency', 'warning', targetName, `Ping target "${targetName}" (${targetHost}) has high latency: ${latency}ms`, {
        targetId: targetId,
        targetName: targetName,
        host: targetHost,
        latency: latency,
        packetLoss: packetLoss,
        threshold: threshold
      });
    }
  }

  if (shouldNotify && message) {
    sendTelegramMessage(message);
    notifyPingStatusEmail(targetId, targetName, targetHost, status, latency, packetLoss);
  }
}

// Email notification functions
function sendEmail(subject, htmlContent, textContent = '') {
  if (!emailTransporter || !settings.email || !settings.email.enabled || !settings.email.toEmail) {
    return;
  }

  try {
    const mailOptions = {
      from: settings.email.fromEmail || settings.email.smtpUser,
      to: settings.email.toEmail,
      subject: subject,
      html: htmlContent,
      text: textContent || htmlContent.replace(/<[^>]*>/g, '') // Strip HTML tags for text version
    };

    emailTransporter.sendMail(mailOptions)
      .then(() => {
        console.log('[EMAIL] Message sent successfully');
      })
      .catch(error => {
        console.error('[EMAIL] Failed to send message:', error.message);
      });
  } catch (error) {
    console.error('[EMAIL] Error sending message:', error.message);
  }
}

function notifyDeviceStatusEmail(deviceId, deviceName, status, details = '') {
  if (!settings.email || !settings.email.enabled) return;

  const timestamp = new Date().toLocaleString('id-ID');
  let subject = '';
  let htmlContent = '';

  if (status === 'up' && settings.email.notifyOnDeviceUp) {
    subject = `🟢 Device UP Alert - ${deviceName}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #22c55e;">🟢 Device UP Alert</h2>
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 Device:</strong> ${deviceName} (${deviceId})</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>📊 Status:</strong> Device is now online</p>
          ${details ? `<p><strong>ℹ️ Details:</strong> ${details}</p>` : ''}
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
  } else if (status === 'down' && settings.email.notifyOnDeviceDown) {
    subject = `🔴 Device DOWN Alert - ${deviceName}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #ef4444;">🔴 Device DOWN Alert</h2>
        <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 Device:</strong> ${deviceName} (${deviceId})</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>📊 Status:</strong> Device is offline</p>
          ${details ? `<p><strong>ℹ️ Details:</strong> ${details}</p>` : ''}
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
  }

  if (subject && htmlContent) {
    sendEmail(subject, htmlContent);
  }
}

function notifyHighCpuEmail(deviceId, deviceName, cpuValue) {
  if (!settings.email || !settings.email.enabled || !settings.email.notifyOnHighCpu) return;

  const threshold = settings.email.cpuThreshold || 80;
  if (cpuValue >= threshold) {
    const timestamp = new Date().toLocaleString('id-ID');
    const subject = `⚠️ High CPU Usage Alert - ${deviceName}`;
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #f59e0b;">⚠️ High CPU Usage Alert</h2>
        <div style="background: #fffbeb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 Device:</strong> ${deviceName} (${deviceId})</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>📊 CPU Usage:</strong> ${cpuValue}%</p>
          <p><strong>🎯 Threshold:</strong> ${threshold}%</p>
          <p><strong>🚨 Status:</strong> CPU usage is above threshold!</p>
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;

    sendEmail(subject, htmlContent);
  }
}

function notifyPingStatusEmail(targetId, targetName, targetHost, status, latency = null, packetLoss = null) {
  if (!settings.email || !settings.email.enabled) return;

  const timestamp = new Date().toLocaleString('id-ID');
  let subject = '';
  let htmlContent = '';
  let shouldNotify = false;

  if (status === 'down' && settings.email.notifyOnPingDown) {
    subject = `🔴 Ping Target Down Alert - ${targetName}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #ef4444;">🔴 Ping Target Down Alert</h2>
        <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 Target:</strong> ${targetName} (${targetHost})</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>❌ Status:</strong> Target is unreachable</p>
          <p><strong>📊 Packet Loss:</strong> 100%</p>
          <p><strong>🚨 Alert:</strong> Ping target is down!</p>
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
    shouldNotify = true;
  } else if (status === 'up' && settings.email.notifyOnPingUp) {
    subject = `🟢 Ping Target Up Alert - ${targetName}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #22c55e;">🟢 Ping Target Up Alert</h2>
        <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 Target:</strong> ${targetName} (${targetHost})</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>✅ Status:</strong> Target is back online</p>
          <p><strong>📊 Latency:</strong> ${latency}ms</p>
          <p><strong>📊 Packet Loss:</strong> ${packetLoss}%</p>
          <p><strong>🎉 Alert:</strong> Ping target recovered!</p>
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
    shouldNotify = true;
  } else if (status === 'timeout' && settings.email.notifyOnPingTimeout) {
    subject = `⏰ Ping Timeout Alert - ${targetName}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #f59e0b;">⏰ Ping Timeout Alert</h2>
        <div style="background: #fffbeb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 Target:</strong> ${targetName} (${targetHost})</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>⏳ Status:</strong> Ping request timed out</p>
          <p><strong>📊 Packet Loss:</strong> 100%</p>
          <p><strong>🚨 Alert:</strong> Ping timeout detected!</p>
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
    shouldNotify = true;
  } else if (status === 'high_latency' && settings.email.notifyOnPingHighLatency && latency !== null) {
    const threshold = settings.email.pingLatencyThreshold || 50;
    if (latency >= threshold) {
      subject = `🐌 High Ping Latency Alert - ${targetName}`;
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #f59e0b;">🐌 High Ping Latency Alert</h2>
          <div style="background: #fffbeb; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>📍 Target:</strong> ${targetName} (${targetHost})</p>
            <p><strong>⏰ Time:</strong> ${timestamp}</p>
            <p><strong>📊 Latency:</strong> ${latency}ms</p>
            <p><strong>🎯 Threshold:</strong> ${threshold}ms</p>
            <p><strong>📊 Packet Loss:</strong> ${packetLoss}%</p>
            <p><strong>🚨 Alert:</strong> Ping latency is above threshold!</p>
          </div>
          <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
        </div>
      `;
      shouldNotify = true;
    }
  }

  if (shouldNotify && subject && htmlContent) {
    sendEmail(subject, htmlContent);
  }
}

// Flapping Detection Functions
function isDeviceFlapping(deviceId) {
  if (!settings.flapping || !settings.flapping.enabled) return false;

  const history = deviceFlappingHistory[deviceId];
  if (!history || history.transitions.length < 2) return false;

  const now = Date.now();
  const windowMs = settings.flapping.deviceWindowMinutes * 60 * 1000;
  const threshold = settings.flapping.deviceThreshold;

  // Filter transitions within the time window
  const recentTransitions = history.transitions.filter(t => now - t.timestamp < windowMs);

  // Update history with filtered transitions
  history.transitions = recentTransitions;

  return recentTransitions.length >= threshold;
}

function recordDeviceTransition(deviceId, status) {
  if (!deviceFlappingHistory[deviceId]) {
    deviceFlappingHistory[deviceId] = {
      transitions: [],
      isFlapping: false,
      lastStatus: null
    };
  }

  const history = deviceFlappingHistory[deviceId];
  const now = Date.now();

  // Only record if status actually changed
  if (history.lastStatus !== status) {
    history.transitions.push({
      timestamp: now,
      status: status,
      from: history.lastStatus
    });

    // Keep only recent transitions (last 24 hours)
    const oneDayMs = 24 * 60 * 60 * 1000;
    history.transitions = history.transitions.filter(t => now - t.timestamp < oneDayMs);

    history.lastStatus = status;

    // Check if flapping state changed
    const currentlyFlapping = isDeviceFlapping(deviceId);
    if (currentlyFlapping !== history.isFlapping) {
      history.isFlapping = currentlyFlapping;
      notifyFlappingStatus(deviceId, snmpDevices[deviceId]?.name || deviceId, 'device', currentlyFlapping);
    }
  }
}

function isPingFlapping(targetId) {
  if (!settings.flapping || !settings.flapping.enabled) return false;

  const history = pingFlappingHistory[targetId];
  if (!history || history.transitions.length < 2) return false;

  const now = Date.now();
  const windowMs = settings.flapping.pingWindowMinutes * 60 * 1000;
  const threshold = settings.flapping.pingThreshold;

  // Filter transitions within the time window
  const recentTransitions = history.transitions.filter(t => now - t.timestamp < windowMs);

  // Update history with filtered transitions
  history.transitions = recentTransitions;

  return recentTransitions.length >= threshold;
}

function recordPingTransition(targetId, status) {
  if (!pingFlappingHistory[targetId]) {
    pingFlappingHistory[targetId] = {
      transitions: [],
      isFlapping: false,
      lastStatus: null
    };
  }

  const history = pingFlappingHistory[targetId];
  const now = Date.now();

  // Only record if status actually changed
  if (history.lastStatus !== status) {
    history.transitions.push({
      timestamp: now,
      status: status,
      from: history.lastStatus
    });

    // Keep only recent transitions (last 24 hours)
    const oneDayMs = 24 * 60 * 60 * 1000;
    history.transitions = history.transitions.filter(t => now - t.timestamp < oneDayMs);

    history.lastStatus = status;

    // Check if flapping state changed
    const currentlyFlapping = isPingFlapping(targetId);
    if (currentlyFlapping !== history.isFlapping) {
      history.isFlapping = currentlyFlapping;
      const target = pingTargets.find(t => t.id === targetId);
      const targetName = target ? target.name : `Target ${targetId}`;
      const targetHost = target ? target.host : 'unknown';
      notifyFlappingStatus(targetId, targetName, 'ping', currentlyFlapping, targetHost);
    }
  }
}

function notifyFlappingStatus(id, name, type, isFlapping, host = '') {
  if (!settings.flapping || (!settings.flapping.notifyOnFlappingStart && !settings.flapping.notifyOnFlappingStop)) return;

  const timestamp = new Date().toLocaleString('id-ID');
  const alertKey = `${type}_${id}`;

  if (isFlapping && settings.flapping.notifyOnFlappingStart) {
    if (!flappingAlerts[alertKey]) {
      // New flapping detected
      const message = `🔄 <b>Flapping Detected</b>\n\n` +
                     `📍 <b>${type === 'device' ? 'Device' : 'Ping Target'}:</b> ${name}${host ? ` (${host})` : ''}\n` +
                     `⏰ <b>Time:</b> ${timestamp}\n` +
                     `⚠️ <b>Status:</b> ${type === 'device' ? 'Device' : 'Target'} is flapping!\n` +
                     `🚨 <b>Action:</b> Notifications suppressed until stable`;

      sendTelegramMessage(message);
      notifyFlappingEmail(id, name, type, true, host);

      logEvent('flapping_start', 'warning', name, `${type === 'device' ? 'Device' : 'Ping target'} "${name}" started flapping`, {
        id: id,
        name: name,
        type: type,
        host: host
      });

      flappingAlerts[alertKey] = { startTime: Date.now(), isActive: true };
    }
  } else if (!isFlapping && settings.flapping.notifyOnFlappingStop) {
    if (flappingAlerts[alertKey] && flappingAlerts[alertKey].isActive) {
      // Flapping stopped
      const duration = Math.round((Date.now() - flappingAlerts[alertKey].startTime) / 1000 / 60);
      const message = `✅ <b>Flapping Resolved</b>\n\n` +
                     `📍 <b>${type === 'device' ? 'Device' : 'Ping Target'}:</b> ${name}${host ? ` (${host})` : ''}\n` +
                     `⏰ <b>Time:</b> ${timestamp}\n` +
                     `⏱️ <b>Duration:</b> ${duration} minutes\n` +
                     `✅ <b>Status:</b> ${type === 'device' ? 'Device' : 'Target'} is now stable\n` +
                     `📢 <b>Action:</b> Normal notifications resumed`;

      sendTelegramMessage(message);
      notifyFlappingEmail(id, name, type, false, host, duration);

      logEvent('flapping_stop', 'info', name, `${type === 'device' ? 'Device' : 'Ping target'} "${name}" stopped flapping after ${duration} minutes`, {
        id: id,
        name: name,
        type: type,
        host: host,
        durationMinutes: duration
      });

      flappingAlerts[alertKey].isActive = false;
    }
  }
}

function notifyFlappingEmail(id, name, type, isFlapping, host = '', duration = null) {
  if (!settings.email || !settings.email.smtp || !settings.email.smtp.host) return;

  const timestamp = new Date().toLocaleString('id-ID');
  let subject, htmlContent;

  if (isFlapping) {
    subject = `🔄 Flapping Detected - ${name}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #f59e0b;">🔄 Flapping Detected</h2>
        <div style="background: #fffbeb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 ${type === 'device' ? 'Device' : 'Ping Target'}:</strong> ${name}${host ? ` (${host})` : ''}</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>⚠️ Status:</strong> ${type === 'device' ? 'Device' : 'Target'} is flapping!</p>
          <p><strong>🚨 Action:</strong> Notifications suppressed until stable</p>
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
  } else {
    subject = `✅ Flapping Resolved - ${name}`;
    htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #10b981;">✅ Flapping Resolved</h2>
        <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>📍 ${type === 'device' ? 'Device' : 'Ping Target'}:</strong> ${name}${host ? ` (${host})` : ''}</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>⏱️ Duration:</strong> ${duration} minutes</p>
          <p><strong>✅ Status:</strong> ${type === 'device' ? 'Device' : 'Target'} is now stable</p>
          <p><strong>📢 Action:</strong> Normal notifications resumed</p>
        </div>
        <p style="color: #666; font-size: 12px;">This alert was generated by SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
  }

  sendEmail(subject, htmlContent);
}

// Load SNMP devices config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const snmpSessions = {}; // Map of device sessions
const snmpDevices = {}; // Map of device config

// Migration function to convert old string-based interfaces to new object format
function migrateInterfaceData() {
  let migrated = false;
  config.snmpDevices.forEach(device => {
    if (device.selectedInterfaces && Array.isArray(device.selectedInterfaces)) {
      const migratedInterfaces = device.selectedInterfaces.map(iface => {
        if (typeof iface === 'string') {
          // Old format: interface name as string
          console.log(`[MIGRATION] Converting old interface format for ${device.id}: ${iface}`);
          // We can't determine the index from just the name, so we'll skip these
          // They will need to be re-selected by the user
          migrated = true;
          return null;
        } else if (typeof iface === 'object' && iface.index && iface.name) {
          // Already in new format
          return iface;
        } else {
          // Invalid format, skip
          console.warn(`[MIGRATION] Invalid interface format for ${device.id}, skipping:`, iface);
          migrated = true;
          return null;
        }
      }).filter(iface => iface !== null);
      
      if (migratedInterfaces.length !== device.selectedInterfaces.length) {
        console.log(`[MIGRATION] Migrated ${device.id}: ${device.selectedInterfaces.length} -> ${migratedInterfaces.length} interfaces`);
        device.selectedInterfaces = migratedInterfaces;
        migrated = true;
      }
    }
  });
  
  if (migrated) {
    saveConfig();
    console.log('[MIGRATION] Interface data migration completed and saved');
  }
}

// Run migration on startup
migrateInterfaceData();

// Initialize SNMP sessions for enabled devices
config.snmpDevices.forEach(device => {
  if (device.enabled) {
    // Auto-detect vendor if not specified
    if (!device.vendor) {
      device.vendor = 'standard'; // Will be updated during first discovery
    }
    snmpDevices[device.id] = device;
    snmpSessions[device.id] = snmp.createSession(device.host, device.community, {
      timeout: 5000, // Increased from 1000ms to 5000ms for better reliability
      retries: 1    // Allow 1 retry
    });
    console.log(`SNMP Session initialized for device: ${device.name} (${device.host}) - Vendor: ${device.vendor}`);
  }
});

// Express configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', false); // Disable view caching for development
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parser middleware
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Authentication middleware
const requireAuth = (req, res, next) => {
  const isAuthenticated = req.cookies.authenticated === 'true';
  if (isAuthenticated || req.path === '/login' || req.path === '/about' || req.path === '/status' || req.path.startsWith('/api/')) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Apply authentication to protected routes
app.use(requireAuth);

// Settings configuration
let settings = {
  pollingInterval: 300000, // 5 minutes in milliseconds
  pingInterval: 30000, // 30 seconds in milliseconds
  dataRetention: 730, // days (24 months)
  influxdb: {
    url: 'http://localhost:8086',
    org: 'indobsd',
    bucket: 'graphts',
    token: 'Sag1KBQNatpHmaMDoCDLB1Vrt-QAMTfwL_K13gRYjUihTrzlRSOdoDB9HwH6imIJpSMz4XgfG9AEAL4FtwUZpQ=='
  },
  email: {
    enabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    fromEmail: '',
    toEmail: '',
    notifyOnDeviceDown: true,
    notifyOnDeviceUp: true,
    notifyOnHighCpu: true,
    cpuThreshold: 80,
    notifyOnInterfaceDown: false,
    notifyOnPingDown: true,
    notifyOnPingUp: true,
    notifyOnPingTimeout: true,
    notifyOnPingHighLatency: true,
    pingLatencyThreshold: 50
  }
};

// Load or create settings file
const settingsFile = './settings.json';
if (fs.existsSync(settingsFile)) {
  const loadedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings = { ...settings, ...loadedSettings };
  // Ensure influxdb object exists
  if (!settings.influxdb) {
    settings.influxdb = {
      url: 'http://localhost:8086',
      org: 'indobsd',
      bucket: 'graphts',
      token: 'Sag1KBQNatpHmaMDoCDLB1Vrt-QAMTfwL_K13gRYjUihTrzlRSOdoDB9HwH6imIJpSMz4XgfG9AEAL4FtwUZpQ=='
    };
  }
  // Ensure email object exists
  if (!settings.email) {
    settings.email = {
      enabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpPass: '',
      fromEmail: '',
      toEmail: '',
      notifyOnDeviceDown: true,
      notifyOnDeviceUp: true,
      notifyOnHighCpu: true,
      cpuThreshold: 80,
      notifyOnInterfaceDown: false,
      notifyOnPingDown: true,
      notifyOnPingUp: true,
      notifyOnPingTimeout: true,
      notifyOnPingHighLatency: true,
      pingLatencyThreshold: 50
    };
  }
  // Ensure flapping object exists
  if (!settings.flapping) {
    settings.flapping = {
      enabled: true,
      deviceThreshold: 5,
      deviceWindowMinutes: 10,
      pingThreshold: 3,
      pingWindowMinutes: 5,
      suppressNotifications: true,
      notifyOnFlappingStart: true,
      notifyOnFlappingStop: true
    };
  }
} else {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// InfluxDB configuration from settings
const client = new InfluxDB({ url: settings.influxdb.url, token: settings.influxdb.token });
const queryApi = client.getQueryApi(settings.influxdb.org);

// Telegram Bot initialization
let telegramBot = null;
if (settings.telegram && settings.telegram.enabled && settings.telegram.botToken) {
  try {
    telegramBot = new TelegramBot(settings.telegram.botToken, { polling: false });
    console.log('[TELEGRAM] Bot initialized successfully');
  } catch (error) {
    console.error('[TELEGRAM] Failed to initialize bot:', error.message);
  }
}

// Email transporter initialization
let emailTransporter = null;
if (settings.email && settings.email.enabled && settings.email.smtpHost && settings.email.smtpUser && settings.email.smtpPass) {
  try {
    emailTransporter = nodemailer.createTransporter({
      host: settings.email.smtpHost,
      port: settings.email.smtpPort,
      secure: settings.email.smtpSecure,
      auth: {
        user: settings.email.smtpUser,
        pass: settings.email.smtpPass
      }
    });
    console.log('[EMAIL] SMTP transporter initialized successfully');
  } catch (error) {
    console.error('[EMAIL] Failed to initialize SMTP transporter:', error.message);
  }
}

// Ping configuration
let pingTargets = [
  { id: 1, name: 'Google DNS', host: '8.8.8.8', group: 'DNS', enabled: true },
  { id: 2, name: 'Cloudflare DNS', host: '1.1.1.1', group: 'DNS', enabled: true },
  { id: 3, name: 'Local Gateway', host: '192.168.1.1', group: 'Network', enabled: true }
];

// Ping status tracking for notifications
let pingStatusHistory = {}; // Track previous ping status for each target

// Device status tracking for notifications
let deviceStatusHistory = {}; // Track previous device status for each device

// Flapping detection tracking
let deviceFlappingHistory = {}; // Track device state transitions for flapping detection
let pingFlappingHistory = {}; // Track ping state transitions for flapping detection
let flappingAlerts = {}; // Track active flapping alerts to avoid duplicate notifications

// Load or create ping targets file
const pingTargetsFile = './ping-targets.json';
if (fs.existsSync(pingTargetsFile)) {
  pingTargets = JSON.parse(fs.readFileSync(pingTargetsFile, 'utf8'));
} else {
  fs.writeFileSync(pingTargetsFile, JSON.stringify(pingTargets, null, 2));
}

// Helper function to save config
function saveConfig() {
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  console.log('Config saved');
}

// Helper function to save settings
function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  console.log('Settings saved');
}

// Helper function to save ping targets
function savePingTargets() {
  fs.writeFileSync(pingTargetsFile, JSON.stringify(pingTargets, null, 2));
  console.log('Ping targets saved');
}

// Helper function to save ping history
function savePingHistory() {
  fs.writeFileSync(pingHistoryFile, JSON.stringify(pingHistory, null, 2));
}

// Helper function to add ping result to database
function addPingToDatabase(targetId, result) {
  try {
    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const pingPoint = new Point('ping_metric')
      .tag('target_id', targetId.toString())
      .tag('target_name', pingTargets.find(t => t.id === targetId)?.name || 'unknown')
      .tag('metric', 'ping')
      .timestamp(new Date())
      .floatField('latency', parseFloat(result.time) || 0)
      .floatField('packet_loss', parseFloat(result.packetLoss) || 0)
      .intField('alive', result.alive ? 1 : 0);

    writeApi.writePoint(pingPoint);
    writeApi.close().then(() => {
      console.log(`[PING] Data written for target ${targetId}: ${result.time}ms, ${result.packetLoss}% loss, alive: ${result.alive}`);
    }).catch(err => {
      console.error('InfluxDB ping write error:', err);
    });
  } catch (err) {
    console.error('Error creating ping write API:', err);
  }
}

// Helper function to cleanup old ping data from database (older than 1 month)
async function cleanupOldPingData() {
  try {
    console.log('[PING CLEANUP] Ping data cleanup is currently disabled due to InfluxDB API compatibility issues');
    // TODO: Re-enable when InfluxDB client API is updated
    /*
    console.log('[PING CLEANUP] Starting database cleanup for ping data older than 1 month');

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    // Use InfluxDB query API to delete old ping data
    const cutoffIso = oneMonthAgo.toISOString();
    const deleteQuery = `
      from(bucket: "${settings.influxdb.bucket}")
        |> range(start: 1970-01-01T00:00:00Z, stop: ${cutoffIso})
        |> filter(fn: (r) => r._measurement == "ping_metric")
        |> delete()
    `;

    const queryApi = client.getQueryApi(settings.influxdb.org);
    await queryApi.query(deleteQuery);

    console.log('[PING CLEANUP] Database cleanup completed for ping data');
    */
  } catch (err) {
    console.error('[PING CLEANUP] Error cleaning up ping data:', err);
  }
}

// Cleanup old ping data on startup
cleanupOldPingData();

// Schedule cleanup every 24 hours
setInterval(cleanupOldPingData, 24 * 60 * 60 * 1000);

// History management functions
let eventHistory = [];
const historyFile = './history.json';

// Load history from file
function loadHistory() {
  try {
    if (fs.existsSync(historyFile)) {
      const data = fs.readFileSync(historyFile, 'utf8');
      eventHistory = JSON.parse(data);
    } else {
      eventHistory = [];
      saveHistory();
    }
  } catch (err) {
    console.error('Error loading history:', err);
    eventHistory = [];
  }
}

// Save history to file
function saveHistory() {
  try {
    fs.writeFileSync(historyFile, JSON.stringify(eventHistory, null, 2));
  } catch (err) {
    console.error('Error saving history:', err);
  }
}

// Add event to history
function logEvent(type, severity, source, message, details = null) {
  const event = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type: type,
    severity: severity,
    source: source,
    message: message,
    details: details
  };

  eventHistory.unshift(event); // Add to beginning of array

  // Keep only last 10000 events to prevent file from growing too large
  if (eventHistory.length > 10000) {
    eventHistory = eventHistory.slice(0, 10000);
  }

  saveHistory();

  // Send Telegram notification if enabled
  if (settings.telegram && settings.telegram.enabled) {
    sendEventNotification(event);
  }

  console.log(`[HISTORY] ${severity.toUpperCase()}: ${message}`);
}

// Send event notification via Telegram
function sendEventNotification(event) {
  if (!telegramBot || !settings.telegram.chatId) return;

  let emoji = '';
  switch (event.severity) {
    case 'critical': emoji = '🚨'; break;
    case 'error': emoji = '❌'; break;
    case 'warning': emoji = '⚠️'; break;
    case 'info': emoji = 'ℹ️'; break;
  }

  const message = `${emoji} **${event.severity.toUpperCase()}**\n\n` +
    `**Event:** ${event.type.replace(/_/g, ' ').toUpperCase()}\n` +
    `**Source:** ${event.source}\n` +
    `**Time:** ${new Date(event.timestamp).toLocaleString()}\n` +
    `**Message:** ${event.message}`;

  try {
    telegramBot.sendMessage(settings.telegram.chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error sending Telegram notification:', err);
  }
}

// Load history on startup
loadHistory();

// Route for dashboard page
app.get('/', (req, res) => {
  // Get all interfaces from all devices for total count
  let allInterfaces = [];
  Object.values(snmpDevices).forEach(device => {
    if (device.selectedInterfaces) {
      allInterfaces = allInterfaces.concat(device.selectedInterfaces);
    }
  });
  
  // Ensure pingTargets is defined
  const safePingTargets = pingTargets || [];
  
  // Group ping targets by group for dashboard
  const groupedPingTargets = {};
  safePingTargets.forEach(target => {
    if (!groupedPingTargets[target.group]) {
      groupedPingTargets[target.group] = [];
    }
    groupedPingTargets[target.group].push(target);
  });
  
  res.render('index', { 
    devices: snmpDevices,
    interfaces: allInterfaces,
    pingTargets: safePingTargets,
    groupedPingTargets: groupedPingTargets,
    settings: settings
  });
});

// Route for device management page
app.get('/devices', (req, res) => {
  res.render('devices', { devices: snmpDevices });
});

// Route for settings page
app.get('/settings', (req, res) => {
  res.render('settings', { 
    settings: settings,
    devices: snmpDevices,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for history page
app.get('/history', (req, res) => {
  res.render('history');
});

// Route for about page
app.get('/about', (req, res) => {
  res.render('about');
});

// Route for public status page (no authentication required)
app.get('/status', (req, res) => {
  res.render('status', {
    title: 'System Status - SMon'
  });
});

// Route for ping monitoring page
app.get('/ping', (req, res) => {
  // Group ping targets by group
  const groupedTargets = {};
  pingTargets.forEach(target => {
    if (!groupedTargets[target.group]) {
      groupedTargets[target.group] = [];
    }
    groupedTargets[target.group].push(target);
  });

  res.render('ping', { 
    pingTargets: pingTargets,
    groupedTargets: groupedTargets,
    settings: settings
  });
});

// API to get ping targets
app.get('/api/ping-targets', (req, res) => {
  res.json(pingTargets);
});

// API to add ping target
app.post('/api/ping-targets', (req, res) => {
  try {
    const { name, host, group } = req.body;
    
    if (!name || !host || !group) {
      return res.status(400).json({ error: 'Name, host, and group are required' });
    }
    
    // Check if host already exists
    const existingTarget = pingTargets.find(target => target.host === host);
    if (existingTarget) {
      return res.status(400).json({ error: 'Host already exists' });
    }
    
    const newTarget = {
      id: Math.max(...pingTargets.map(t => t.id), 0) + 1,
      name: name.trim(),
      host: host.trim(),
      group: group.trim(),
      enabled: true
    };
    
    pingTargets.push(newTarget);
    savePingTargets();
    
    res.json({
      success: true,
      message: 'Ping target added successfully',
      target: newTarget
    });
  } catch (err) {
    console.error('Error adding ping target:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to delete ping target
app.delete('/api/ping-targets/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = pingTargets.findIndex(target => target.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Ping target not found' });
    }
    
    pingTargets.splice(index, 1);
    savePingTargets();
    
    res.json({
      success: true,
      message: 'Ping target deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting ping target:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to toggle ping target status
app.patch('/api/ping-targets/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const target = pingTargets.find(target => target.id === id);
    
    if (!target) {
      return res.status(404).json({ error: 'Ping target not found' });
    }
    
    target.enabled = !target.enabled;
    savePingTargets();
    
    res.json({
      success: true,
      message: 'Ping target status updated successfully',
      target: target
    });
  } catch (err) {
    console.error('Error toggling ping target:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to perform ping test
app.post('/api/ping-test', async (req, res) => {
  try {
    const { host, targetId } = req.body;
    
    if (!host) {
      return res.status(400).json({ error: 'Host is required' });
    }
    
    const result = await ping.promise.probe(host, {
      timeout: 5,
      min_reply: 1,
      extra: ['-c', '3'] // Send 3 packets
    });
    
    // Save to database if targetId provided
    if (targetId) {
      addPingToDatabase(targetId, result);
    }
    
    res.json({
      success: true,
      host: host,
      alive: result.alive,
      time: result.time,
      packetLoss: result.packetLoss,
      output: result.output
    });
  } catch (err) {
    console.error('Error performing ping test:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to get ping history for a target
app.get('/api/ping-history/:targetId', async (req, res) => {
  try {
    const targetId = req.params.targetId;
    const { startDate, endDate, timeRange } = req.query;

    // Build InfluxDB query for ping data
    let rangeStart = timeRange || '-30d'; // Default to last 30 days
    let rangeStop = '';

    if (startDate || endDate) {
      if (startDate && endDate) {
        rangeStart = `time(v: "${new Date(startDate).toISOString()}")`;
        rangeStop = `, stop: time(v: "${new Date(endDate).toISOString()}")`;
      } else if (startDate) {
        rangeStart = `time(v: "${new Date(startDate).toISOString()}")`;
      } else if (endDate) {
        rangeStart = '-30d';
        rangeStop = `, stop: time(v: "${new Date(endDate).toISOString()}")`;
      }
    }

    const query = `
      from(bucket: "${settings.influxdb.bucket}")
      |> range(start: ${rangeStart}${rangeStop})
      |> filter(fn: (r) => r._measurement == "ping_metric")
      |> filter(fn: (r) => r._field != "")
      |> filter(fn: (r) => r.target_id == "${targetId}")
      |> filter(fn: (r) => r.metric == "ping")
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
    `;

    console.log('[PING HISTORY] Query:', query.substring(0, 200));

    const data = [];
    let hasError = false;
    let responded = false;

    queryApi.queryRows(query, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        data.push({
          timestamp: o._time,
          alive: o.alive === 1,
          time: parseFloat(o.latency) || 0,
          packetLoss: parseFloat(o.packet_loss) || 0
        });
      },
      error(error) {
        console.error('InfluxDB ping history query error:', error);
        hasError = true;
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Database query error' });
        }
      },
      complete() {
        if (!hasError && !responded) {
          responded = true;
          res.json({
            success: true,
            targetId: parseInt(targetId),
            count: data.length,
            data: data
          });
        }
      }
    });

  } catch (err) {
    console.error('Error retrieving ping history:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route for login page
app.get('/login', (req, res) => {
  res.render('login', { error: null, success: null });
});

// Route for login processing
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Simple authentication (you can replace this with proper authentication)
  if (username === 'admin' && password === 'admin123') {
    // Set session or cookie for authentication
    res.cookie('authenticated', 'true', { maxAge: 24 * 60 * 60 * 1000 }); // 24 hours
    res.redirect('/');
  } else {
    res.render('login', {
      error: 'Invalid username or password',
      success: null
    });
  }
});

// Route for logout
app.get('/logout', (req, res) => {
  res.clearCookie('authenticated');
  res.redirect('/login');
});

// Route for bandwidth monitoring page
app.get('/monitoring', async (req, res) => {
  try {
    console.log('Route /monitoring called');
    const deviceId = req.query.device || Object.keys(snmpDevices)[0] || null;

    // If no devices are available, render the page with empty devices
    if (Object.keys(snmpDevices).length === 0) {
      return res.render('monitoring', {
        devices: {},
        selectedDevice: null
      });
    }

    // If a specific device is requested but doesn't exist, redirect to monitoring without device
    if (deviceId && !snmpDevices[deviceId]) {
      return res.redirect('/monitoring');
    }

    res.render('monitoring', {
      devices: snmpDevices,
      selectedDevice: deviceId
    });
  } catch (err) {
    console.error('Route error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// API to get all devices
app.get('/api/devices', (req, res) => {
  res.json(snmpDevices);
});

// API to get current settings
app.get('/api/settings', (req, res) => {
  res.json({
    pollingInterval: settings.pollingInterval,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    dataRetention: settings.dataRetention || 730
  });
});

// API to update settings
app.post('/api/settings', (req, res) => {
  try {
    const { pollingIntervalSeconds, pingIntervalSeconds, dataRetentionDays } = req.body;
    
    if (pollingIntervalSeconds) {
      if (pollingIntervalSeconds < 10) {
        return res.status(400).json({ error: 'Polling interval must be at least 10 seconds' });
      }
      // Convert seconds to milliseconds
      const newInterval = pollingIntervalSeconds * 1000;
      settings.pollingInterval = newInterval;
    }
    
    if (pingIntervalSeconds) {
      if (pingIntervalSeconds < 5) {
        return res.status(400).json({ error: 'Ping interval must be at least 5 seconds' });
      }
      if (pingIntervalSeconds > 300) {
        return res.status(400).json({ error: 'Ping interval cannot exceed 300 seconds' });
      }
      // Convert seconds to milliseconds
      const newPingInterval = pingIntervalSeconds * 1000;
      settings.pingInterval = newPingInterval;
    }
    
    if (dataRetentionDays !== undefined) {
      if (dataRetentionDays < 1 || dataRetentionDays > 730) {
        return res.status(400).json({ error: 'Data retention must be between 1 and 730 days' });
      }
      settings.dataRetention = dataRetentionDays;
    }
    
    saveSettings();
    
    // Restart polling if interval changed
    if (pollingIntervalSeconds) {
      restartPolling();
    }
    
    // Cleanup old data if retention changed
    if (dataRetentionDays !== undefined) {
      cleanupOldData();
    }
    
    res.json({
      success: true,
      message: 'Settings updated successfully',
      settings: {
        pollingInterval: settings.pollingInterval,
        pollingIntervalSeconds: settings.pollingInterval / 1000,
        pingInterval: settings.pingInterval,
        pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30,
        dataRetention: settings.dataRetention
      }
    });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to update ping notification settings
app.post('/api/settings/ping-notifications', (req, res) => {
  try {
    const { enabled, notifyOnDown, notifyOnTimeout, notifyOnHighLatency, latencyThreshold } = req.body;
    
    if (!settings.pingNotifications) {
      settings.pingNotifications = {};
    }
    
    settings.pingNotifications.enabled = enabled !== undefined ? enabled : true;
    settings.pingNotifications.notifyOnDown = notifyOnDown !== undefined ? notifyOnDown : true;
    settings.pingNotifications.notifyOnTimeout = notifyOnTimeout !== undefined ? notifyOnTimeout : true;
    settings.pingNotifications.notifyOnHighLatency = notifyOnHighLatency !== undefined ? notifyOnHighLatency : true;
    
    if (latencyThreshold !== undefined) {
      if (latencyThreshold < 10 || latencyThreshold > 500) {
        return res.status(400).json({ error: 'Latency threshold must be between 10 and 500 ms' });
      }
      settings.pingNotifications.latencyThreshold = latencyThreshold;
    }
    
    saveSettings();
    
    res.json({
      success: true,
      pingNotifications: settings.pingNotifications
    });
  } catch (err) {
    console.error('Error updating ping notification settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to test InfluxDB connection
app.post('/api/settings/influxdb/test', async (req, res) => {
  try {
    let { url, org, bucket, token } = req.body;
    
    // If no parameters provided, use current settings
    if (!url || !org || !bucket || !token) {
      url = settings.influxdb.url;
      org = settings.influxdb.org;
      bucket = settings.influxdb.bucket;
      token = settings.influxdb.token;
    }
    
    // Create temporary InfluxDB client
    const testClient = new InfluxDB({ url, token });
    const testQueryApi = testClient.getQueryApi(org);
    
    // Try a simple query to test connection
    const fluxQuery = `from(bucket: "${bucket}") |> range(start: -1m) |> limit(n: 1)`;
    
    return new Promise((resolve) => {
      const results = [];
      testQueryApi.queryRows(fluxQuery, {
        next(row, tableMeta) {
          results.push(row);
        },
        error(error) {
          console.error('InfluxDB test error:', error);
          res.json({
            success: false,
            error: error.message || 'Connection failed'
          });
          resolve();
        },
        complete() {
          res.json({
            success: true,
            message: 'Connection successful'
          });
          resolve();
        }
      });
    });
  } catch (err) {
    console.error('Error testing InfluxDB connection:', err);
    res.status(500).json({ 
      success: false,
      error: err.message || 'Internal Server Error' 
    });
  }
});

// API to save InfluxDB settings
app.post('/api/settings/influxdb', (req, res) => {
  try {
    const { url, org, bucket, token } = req.body;
    
    if (!url || !org || !bucket || !token) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (!settings.influxdb) {
      settings.influxdb = {};
    }
    
    settings.influxdb.url = url.trim();
    settings.influxdb.org = org.trim();
    settings.influxdb.bucket = bucket.trim();
    settings.influxdb.token = token.trim();
    
    saveSettings();
    
    res.json({
      success: true,
      message: 'InfluxDB settings saved successfully',
      influxdb: {
        url: settings.influxdb.url,
        org: settings.influxdb.org,
        bucket: settings.influxdb.bucket,
        token: '***' // Don't send token back
      }
    });
  } catch (err) {
    console.error('Error saving InfluxDB settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to update Telegram settings
app.post('/api/settings/telegram', (req, res) => {
  try {
    const { 
      enabled, 
      botToken, 
      chatId, 
      notifyOnDeviceDown, 
      notifyOnDeviceUp, 
      notifyOnHighCpu, 
      cpuThreshold, 
      notifyOnInterfaceDown,
      notifyOnPingDown,
      notifyOnPingUp,
      notifyOnPingTimeout,
      notifyOnPingHighLatency,
      pingLatencyThreshold
    } = req.body;
    
    if (!settings.telegram) {
      settings.telegram = {};
    }
    
    settings.telegram.enabled = enabled === true || enabled === 'true';
    settings.telegram.botToken = botToken || '';
    settings.telegram.chatId = chatId || '';
    settings.telegram.notifyOnDeviceDown = notifyOnDeviceDown === true || notifyOnDeviceDown === 'true';
    settings.telegram.notifyOnDeviceUp = notifyOnDeviceUp === true || notifyOnDeviceUp === 'true';
    settings.telegram.notifyOnHighCpu = notifyOnHighCpu === true || notifyOnHighCpu === 'true';
    settings.telegram.cpuThreshold = parseInt(cpuThreshold) || 80;
    settings.telegram.notifyOnInterfaceDown = notifyOnInterfaceDown === true || notifyOnInterfaceDown === 'true';
    settings.telegram.notifyOnPingDown = notifyOnPingDown === true || notifyOnPingDown === 'true';
    settings.telegram.notifyOnPingUp = notifyOnPingUp === true || notifyOnPingUp === 'true';
    settings.telegram.notifyOnPingTimeout = notifyOnPingTimeout === true || notifyOnPingTimeout === 'true';
    settings.telegram.notifyOnPingHighLatency = notifyOnPingHighLatency === true || notifyOnPingHighLatency === 'true';
    settings.telegram.pingLatencyThreshold = parseInt(pingLatencyThreshold) || 50;
    
    saveSettings();
    
    // Reinitialize Telegram bot if settings changed
    if (settings.telegram.enabled && settings.telegram.botToken) {
      try {
        telegramBot = new TelegramBot(settings.telegram.botToken, { polling: false });
        console.log('[TELEGRAM] Bot reinitialized successfully');
      } catch (error) {
        console.error('[TELEGRAM] Failed to reinitialize bot:', error.message);
      }
    } else {
      telegramBot = null;
      console.log('[TELEGRAM] Bot disabled');
    }
    
    res.json({
      success: true,
      message: 'Telegram settings saved successfully',
      telegram: {
        enabled: settings.telegram.enabled,
        botToken: settings.telegram.botToken ? '***' : '', // Don't send token back
        chatId: settings.telegram.chatId,
        notifyOnDeviceDown: settings.telegram.notifyOnDeviceDown,
        notifyOnDeviceUp: settings.telegram.notifyOnDeviceUp,
        notifyOnHighCpu: settings.telegram.notifyOnHighCpu,
        cpuThreshold: settings.telegram.cpuThreshold,
        notifyOnInterfaceDown: settings.telegram.notifyOnInterfaceDown,
        notifyOnPingDown: settings.telegram.notifyOnPingDown,
        notifyOnPingUp: settings.telegram.notifyOnPingUp,
        notifyOnPingTimeout: settings.telegram.notifyOnPingTimeout,
        notifyOnPingHighLatency: settings.telegram.notifyOnPingHighLatency,
        pingLatencyThreshold: settings.telegram.pingLatencyThreshold
      }
    });
  } catch (err) {
    console.error('Error saving Telegram settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to test Telegram bot
app.post('/api/settings/telegram/test', async (req, res) => {
  try {
    if (!telegramBot || !settings.telegram || !settings.telegram.enabled || !settings.telegram.chatId) {
      return res.status(400).json({ error: 'Telegram bot is not configured or enabled' });
    }
    
    const testMessage = `🧪 <b>Telegram Bot Test</b>\n\n` +
                        `✅ <b>Status:</b> Bot is working correctly!\n` +
                        `⏰ <b>Time:</b> ${new Date().toLocaleString('id-ID')}\n` +
                        `🤖 <b>Bot:</b> SMon Monitoring System`;
    
    await telegramBot.sendMessage(settings.telegram.chatId, testMessage, { parse_mode: 'HTML' });
    
    res.json({
      success: true,
      message: 'Test message sent successfully'
    });
  } catch (err) {
    console.error('Error testing Telegram bot:', err);
    res.status(500).json({ error: 'Failed to send test message: ' + err.message });
  }
});

// API to save email settings
app.post('/api/settings/email', (req, res) => {
  try {
    const { 
      enabled, 
      smtpHost, 
      smtpPort, 
      smtpSecure, 
      smtpUser, 
      smtpPass, 
      fromEmail, 
      toEmail,
      notifyOnDeviceDown, 
      notifyOnDeviceUp, 
      notifyOnHighCpu, 
      cpuThreshold, 
      notifyOnInterfaceDown,
      notifyOnPingDown,
      notifyOnPingUp,
      notifyOnPingTimeout,
      notifyOnPingHighLatency,
      pingLatencyThreshold
    } = req.body;
    
    if (!settings.email) {
      settings.email = {};
    }
    
    settings.email.enabled = enabled === true || enabled === 'true';
    settings.email.smtpHost = smtpHost || '';
    settings.email.smtpPort = parseInt(smtpPort) || 587;
    settings.email.smtpSecure = smtpSecure === true || smtpSecure === 'true';
    settings.email.smtpUser = smtpUser || '';
    settings.email.smtpPass = smtpPass || '';
    settings.email.fromEmail = fromEmail || '';
    settings.email.toEmail = toEmail || '';
    settings.email.notifyOnDeviceDown = notifyOnDeviceDown === true || notifyOnDeviceDown === 'true';
    settings.email.notifyOnDeviceUp = notifyOnDeviceUp === true || notifyOnDeviceUp === 'true';
    settings.email.notifyOnHighCpu = notifyOnHighCpu === true || notifyOnHighCpu === 'true';
    settings.email.cpuThreshold = parseInt(cpuThreshold) || 80;
    settings.email.notifyOnInterfaceDown = notifyOnInterfaceDown === true || notifyOnInterfaceDown === 'true';
    settings.email.notifyOnPingDown = notifyOnPingDown === true || notifyOnPingDown === 'true';
    settings.email.notifyOnPingUp = notifyOnPingUp === true || notifyOnPingUp === 'true';
    settings.email.notifyOnPingTimeout = notifyOnPingTimeout === true || notifyOnPingTimeout === 'true';
    settings.email.notifyOnPingHighLatency = notifyOnPingHighLatency === true || notifyOnPingHighLatency === 'true';
    settings.email.pingLatencyThreshold = parseInt(pingLatencyThreshold) || 50;
    
    saveSettings();
    
    // Reinitialize email transporter if settings changed
    if (settings.email.enabled && settings.email.smtpHost && settings.email.smtpUser && settings.email.smtpPass) {
      try {
        emailTransporter = nodemailer.createTransporter({
          host: settings.email.smtpHost,
          port: settings.email.smtpPort,
          secure: settings.email.smtpSecure,
          auth: {
            user: settings.email.smtpUser,
            pass: settings.email.smtpPass
          }
        });
        console.log('[EMAIL] SMTP transporter reinitialized successfully');
      } catch (error) {
        console.error('[EMAIL] Failed to reinitialize SMTP transporter:', error.message);
      }
    } else {
      emailTransporter = null;
      console.log('[EMAIL] SMTP transporter disabled');
    }
    
    res.json({
      success: true,
      message: 'Email settings saved successfully',
      email: {
        enabled: settings.email.enabled,
        smtpHost: settings.email.smtpHost,
        smtpPort: settings.email.smtpPort,
        smtpSecure: settings.email.smtpSecure,
        smtpUser: settings.email.smtpUser ? '***' : '', // Don't send password back
        smtpPass: '', // Never send password back
        fromEmail: settings.email.fromEmail,
        toEmail: settings.email.toEmail,
        notifyOnDeviceDown: settings.email.notifyOnDeviceDown,
        notifyOnDeviceUp: settings.email.notifyOnDeviceUp,
        notifyOnHighCpu: settings.email.notifyOnHighCpu,
        cpuThreshold: settings.email.cpuThreshold,
        notifyOnInterfaceDown: settings.email.notifyOnInterfaceDown,
        notifyOnPingDown: settings.email.notifyOnPingDown,
        notifyOnPingUp: settings.email.notifyOnPingUp,
        notifyOnPingTimeout: settings.email.notifyOnPingTimeout,
        notifyOnPingHighLatency: settings.email.notifyOnPingHighLatency,
        pingLatencyThreshold: settings.email.pingLatencyThreshold
      }
    });
  } catch (err) {
    console.error('Error saving email settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to test email configuration
app.post('/api/settings/email/test', async (req, res) => {
  try {
    if (!emailTransporter || !settings.email || !settings.email.enabled || !settings.email.toEmail) {
      return res.status(400).json({ error: 'Email is not configured or enabled' });
    }
    
    const timestamp = new Date().toLocaleString('id-ID');
    const subject = '🧪 Email Test - SMon Monitoring System';
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">🧪 Email Test</h2>
        <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>✅ Status:</strong> Email configuration is working correctly!</p>
          <p><strong>⏰ Time:</strong> ${timestamp}</p>
          <p><strong>🤖 System:</strong> SMon Monitoring Dashboard</p>
          <p><strong>📧 SMTP Host:</strong> ${settings.email.smtpHost}:${settings.email.smtpPort}</p>
          <p><strong>🔒 Secure:</strong> ${settings.email.smtpSecure ? 'Yes' : 'No'}</p>
        </div>
        <p style="color: #666; font-size: 12px;">This is a test email from SMon - SNMP Monitoring Dashboard</p>
      </div>
    `;
    
    await sendEmail(subject, htmlContent);
    
    res.json({
      success: true,
      message: 'Test email sent successfully'
    });
  } catch (err) {
    console.error('Error testing email configuration:', err);
    res.status(500).json({ error: 'Failed to send test email: ' + err.message });
  }
});

// API to save flapping settings
app.post('/api/settings/flapping', (req, res) => {
  try {
    const flappingSettings = req.body;

    // Validate flapping settings
    if (flappingSettings.deviceThreshold < 2 || flappingSettings.deviceThreshold > 20) {
      return res.status(400).json({ error: 'Device threshold must be between 2 and 20' });
    }
    if (flappingSettings.deviceWindowMinutes < 1 || flappingSettings.deviceWindowMinutes > 60) {
      return res.status(400).json({ error: 'Device window must be between 1 and 60 minutes' });
    }
    if (flappingSettings.pingThreshold < 2 || flappingSettings.pingThreshold > 20) {
      return res.status(400).json({ error: 'Ping threshold must be between 2 and 20' });
    }
    if (flappingSettings.pingWindowMinutes < 1 || flappingSettings.pingWindowMinutes > 60) {
      return res.status(400).json({ error: 'Ping window must be between 1 and 60 minutes' });
    }

    // Update settings
    settings.flapping = {
      enabled: flappingSettings.enabled || false,
      deviceThreshold: flappingSettings.deviceThreshold,
      deviceWindowMinutes: flappingSettings.deviceWindowMinutes,
      pingThreshold: flappingSettings.pingThreshold,
      pingWindowMinutes: flappingSettings.pingWindowMinutes,
      suppressNotifications: flappingSettings.suppressNotifications || false,
      notifyOnFlappingStart: flappingSettings.notifyOnFlappingStart || false,
      notifyOnFlappingStop: flappingSettings.notifyOnFlappingStop || false
    };

    saveSettings();

    res.json({
      success: true,
      message: 'Flapping settings saved successfully',
      settings: settings.flapping
    });
  } catch (err) {
    console.error('Error saving flapping settings:', err);
    res.status(500).json({ error: 'Failed to save flapping settings: ' + err.message });
  }
});

// API to get flapping status
app.get('/api/flapping/status', (req, res) => {
  try {
    const flappingStatus = {
      deviceFlapping: {},
      pingFlapping: {},
      activeAlerts: flappingAlerts
    };

    // Get device flapping status
    Object.keys(deviceFlappingHistory).forEach(deviceId => {
      const history = deviceFlappingHistory[deviceId];
      flappingStatus.deviceFlapping[deviceId] = {
        isFlapping: history.isFlapping,
        transitionCount: history.transitions.length,
        lastTransition: history.transitions.length > 0 ? history.transitions[history.transitions.length - 1] : null,
        deviceName: snmpDevices[deviceId]?.name || 'Unknown'
      };
    });

    // Get ping flapping status
    Object.keys(pingFlappingHistory).forEach(targetId => {
      const history = pingFlappingHistory[targetId];
      const target = pingTargets.find(t => t.id === targetId);
      flappingStatus.pingFlapping[targetId] = {
        isFlapping: history.isFlapping,
        transitionCount: history.transitions.length,
        lastTransition: history.transitions.length > 0 ? history.transitions[history.transitions.length - 1] : null,
        targetName: target ? target.name : 'Unknown',
        targetHost: target ? target.host : 'unknown'
      };
    });

    res.json(flappingStatus);
  } catch (err) {
    console.error('Error getting flapping status:', err);
    res.status(500).json({ error: 'Failed to get flapping status: ' + err.message });
  }
});

// API to discover interfaces via SNMP walk
app.post('/api/discover-interfaces', (req, res) => {
  try {
    const { host, community } = req.body;
    if (!host || !community) {
      return res.status(400).json({ error: 'Host and community are required' });
    }

    const tempSession = snmp.createSession(host, community, {
      timeout: 5000,
      retries: 1
    });

    let vendor = 'standard';
    const interfaces = [];
    let completed = false;
    let sysDescrRetrieved = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        tempSession.close();
        console.log(`[DISCOVER] SNMP walk timeout, found ${interfaces.length} interfaces for ${vendor} device`);
        res.json({ interfaces, vendor });
      }
    }, 5000); // 5 second timeout for discovery

    // First, get system description to detect vendor
    tempSession.get(['1.3.6.1.2.1.1.1.0'], function(error, varbinds) {
      if (!error && varbinds && varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
        const sysDescr = varbinds[0].value.toString();
        vendor = detectVendor(sysDescr);
        console.log(`[DISCOVER] Detected vendor: ${vendor} for device ${host}`);
      } else {
        console.log(`[DISCOVER] Could not detect vendor for ${host}, using standard MIB-II`);
      }
      sysDescrRetrieved = true;
    });

    // Use appropriate OID for interface discovery based on vendor
    const ifDescrOid = getVendorOID(vendor, 'ifDescr');

    tempSession.walk(ifDescrOid, 30, function(varbinds) {
      varbinds.forEach(vb => {
        if (snmp.isVarbindError(vb)) {
          // Skip errors
        } else {
          const oidParts = vb.oid.split('.');
          const index = oidParts[oidParts.length - 1];
          // Filter to only accept OID ending with .2.X pattern (ifDescr)
          if (oidParts[oidParts.length - 2] === '2') {
            interfaces.push({
              index: parseInt(index),
              name: vb.value.toString()
            });
          }
        }
      });
    }, function(error) {
      if (error) {
        console.log(`[DISCOVER] SNMP walk error: ${error}`);
      }
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        tempSession.close();
        console.log(`[DISCOVER] SNMP walk completed, found ${interfaces.length} interfaces for ${vendor} device`);
        res.json({ interfaces, vendor });
      }
    });
  } catch (err) {
    console.error('Error discovering interfaces:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to add device
app.post('/api/devices', (req, res) => {
  try {
    const { id, name, host, community, selectedInterfaces, vendor } = req.body;
    if (!id || !name || !host || !community) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (snmpDevices[id]) {
      return res.status(400).json({ error: 'Device ID already exists' });
    }
    
    const newDevice = {
      id,
      name,
      host,
      community,
      vendor: vendor || 'standard', // Default to standard if not specified
      enabled: true,
      selectedInterfaces: selectedInterfaces || []
    };
    
    snmpDevices[id] = newDevice;
    config.snmpDevices.push(newDevice);
    saveConfig();
    
    // Create SNMP session for new device
    snmpSessions[id] = snmp.createSession(host, community, {
      timeout: 5000,
      retries: 1
    });
    
    console.log(`Device added: ${name} (${host}) - Vendor: ${newDevice.vendor}`);
    
    // Log device addition event
    logEvent('device_added', 'info', 'System', `Device "${name}" (${host}) has been added to monitoring`, {
      deviceId: id,
      deviceName: name,
      host: host,
      vendor: newDevice.vendor
    });
    
    res.json(newDevice);
  } catch (err) {
    console.error('Error adding device:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to delete device
app.delete('/api/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!snmpDevices[deviceId]) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = snmpDevices[deviceId];

    // Clean up database data for this device
    try {
      console.log(`[DELETE DEVICE] Starting database cleanup for device: ${deviceId} (${device.name})`);

      // Delete all SNMP metric data for this device from InfluxDB
      // Using direct HTTP call since deleteAPI is not available in this client version
      const deleteUrl = `${settings.influxdb.url}/api/v2/delete`;
      const deleteParams = new URLSearchParams({
        org: settings.influxdb.org,
        bucket: settings.influxdb.bucket
      });

      const response = await fetch(`${deleteUrl}?${deleteParams}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${settings.influxdb.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          start: new Date(0).toISOString(),
          stop: new Date().toISOString(),
          predicate: `_measurement="snmp_metric" AND device="${deviceId}"`
        })
      });

      if (!response.ok) {
        throw new Error(`Delete request failed: ${response.status} ${response.statusText}`);
      }

      console.log(`[DELETE DEVICE] Database cleanup completed for device: ${deviceId}`);

    } catch (dbError) {
      console.error(`[DELETE DEVICE] Error cleaning up database for device ${deviceId}:`, dbError);
      // Continue with device deletion even if database cleanup fails
    }

    // Remove device from memory
    delete snmpDevices[deviceId];

    // Remove from config
    config.snmpDevices = config.snmpDevices.filter(d => d.id !== deviceId);
    saveConfig();

    // Close SNMP session
    if (snmpSessions[deviceId]) {
      snmpSessions[deviceId].close();
      delete snmpSessions[deviceId];
    }

    console.log(`[DELETE DEVICE] Device deleted successfully: ${deviceId} (${device.name})`);
    
    // Log device removal event
    logEvent('device_removed', 'warning', 'System', `Device "${device.name}" (${device.host}) has been removed from monitoring`, {
      deviceId: deviceId,
      deviceName: device.name,
      host: device.host
    });
    
    res.json({
      message: 'Device deleted successfully',
      deviceId: deviceId,
      deviceName: device.name
    });
  } catch (err) {
    console.error('Error deleting device:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to update device
app.put('/api/devices/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    const { name, host, community, selectedInterfaces, enabled } = req.body;
    
    if (!snmpDevices[deviceId]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    if (!name || !host || !community) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Update device in memory
    snmpDevices[deviceId].name = name;
    snmpDevices[deviceId].host = host;
    snmpDevices[deviceId].community = community;
    snmpDevices[deviceId].selectedInterfaces = selectedInterfaces || [];
    if (enabled !== undefined) {
      snmpDevices[deviceId].enabled = enabled;
    }
    
    // Update in config.json
    const deviceIndex = config.snmpDevices.findIndex(d => d.id === deviceId);
    if (deviceIndex !== -1) {
      config.snmpDevices[deviceIndex] = snmpDevices[deviceId];
    }
    saveConfig();
    
    // Close old SNMP session if host or community changed
    if (snmpSessions[deviceId]) {
      delete snmpSessions[deviceId];
    }
    
    // Create new SNMP session with updated credentials
    snmpSessions[deviceId] = snmp.createSession(host, community, {
      timeout: 5000,
      retries: 1
    });
    
    res.json(snmpDevices[deviceId]);
  } catch (err) {
    console.error('Error updating device:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to get interfaces for a device
app.get('/api/devices/:deviceId/interfaces', (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!snmpDevices[deviceId]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const device = snmpDevices[deviceId];
    // Handle both old format (array of strings) and new format (array of {index, name})
    const interfaces = (device.selectedInterfaces || []).map((iface, idx) => {
      if (typeof iface === 'string') {
        // Old format: just interface name, skip these as they don't have valid indices
        console.warn(`[${deviceId}] Skipping interface ${iface} - stored as string without index`);
        return null;
      } else {
        // New format: {index, name}
        return { index: iface.index, name: iface.name };
      }
    }).filter(iface => iface !== null); // Remove null entries
    
    res.json(interfaces);
  } catch (err) {
    console.error('Error getting interfaces:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to update device selected interfaces
app.post('/api/devices/:deviceId/select-interfaces', (req, res) => {
  try {
    const { deviceId } = req.params;
    const { selectedInterfaces } = req.body;
    
    if (!snmpDevices[deviceId]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    snmpDevices[deviceId].selectedInterfaces = selectedInterfaces || [];
    
    // Update config
    const deviceInConfig = config.snmpDevices.find(d => d.id === deviceId);
    if (deviceInConfig) {
      deviceInConfig.selectedInterfaces = selectedInterfaces || [];
      saveConfig();
    }
    
    res.json({ message: 'Interfaces updated', device: snmpDevices[deviceId] });
  } catch (err) {
    console.error('Error updating interfaces:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route for data API
app.get('/api/data', async (req, res) => {
  try {
    console.log('Route /api/data called');
    const deviceId = req.query.device || Object.keys(snmpDevices)[0] || null;
    const interface = req.query.interface || 'all';
    const direction = req.query.direction || 'all'; // 'rx', 'tx', or 'all'
    const metric = req.query.metric || 'bandwidth'; // 'bandwidth' or 'cpu'
    const timeRange = req.query.timeRange || '-24h';
    
    if (!deviceId || !snmpDevices[deviceId]) {
      return res.status(400).json({ error: 'Device not found' });
    }

    // Build InfluxDB query with time range support
    let rangeStart = timeRange;
    let rangeStop = '';
    
    if (timeRange.startsWith('custom:')) {
      // Format: custom:2024-11-20T00:00:00,2024-11-20T23:59:59
      try {
        const parts = timeRange.substring(7).split(',');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          console.error('[API/DATA] Invalid custom range format:', timeRange);
          // Fallback to last 24 hours
          rangeStart = '-24h';
          rangeStop = '';
        } else {
          let startDate = parts[0].trim();
          let endDate = parts[1].trim();
          
          // If no time specified, add 00:00:00 and 23:59:59
          if (startDate.length === 10) startDate += 'T00:00:00';
          if (endDate.length === 10) endDate += 'T23:59:59';
          
          // Convert to ISO format with Z suffix for InfluxDB
          const startIso = new Date(startDate).toISOString();
          const endIso = new Date(endDate).toISOString();
          
          // Validate dates
          if (isNaN(new Date(startIso).getTime()) || isNaN(new Date(endIso).getTime())) {
            console.error('[API/DATA] Invalid date format:', { startDate, endDate });
            rangeStart = '-24h';
            rangeStop = '';
          } else if (new Date(startIso) >= new Date(endIso)) {
            console.error('[API/DATA] Start date >= End date:', { startIso, endIso });
            rangeStart = '-24h';
            rangeStop = '';
          } else {
            console.log(`[API/DATA] Custom range - Start: ${startDate} -> ${startIso}, End: ${endDate} -> ${endIso}`);
            
            // For custom dates, use time() function to convert strings - NO quotes needed in time() function
            rangeStart = `time(v: "${startIso}")`;
            rangeStop = `, stop: time(v: "${endIso}")`;
          }
        }
      } catch (err) {
        console.error('[API/DATA] Error parsing custom date range:', err);
        // Fallback to last 24 hours
        rangeStart = '-24h';
        rangeStop = '';
      }
    } else {
      // For relative ranges like -24h, NO quotes needed - just the value
      rangeStart = timeRange;
      rangeStop = '';
    }

    let query = `
      from(bucket: "${settings.influxdb.bucket}")
      |> range(start: ${rangeStart}${rangeStop})
      |> filter(fn: (r) => r._measurement == "snmp_metric")
      |> filter(fn: (r) => r._field == "value")
      |> filter(fn: (r) => r.device == "${deviceId}")
    `;
    
    if (metric === 'cpu') {
      query += ` |> filter(fn: (r) => r.metric == "cpu")`;
      query += `
        |> filter(fn: (r) => r._value >= 0 and r._value <= 100)
      `;
    } else {
      // Bandwidth data
      if (interface !== 'all') {
        query += ` |> filter(fn: (r) => r.interface == "${interface}")`;
      }
      if (direction !== 'all') {
        query += ` |> filter(fn: (r) => r.direction == "${direction}")`;
      }
      query += `
        |> derivative(unit: 1s, nonNegative: true)
        |> map(fn: (r) => ({ r with _value: r._value * 8.0 / 1000000.0 }))
        |> filter(fn: (r) => r._value > 0)
      `;
    }
    
    console.log('[API/DATA] Query:', query.substring(0, 300));
    const data = [];
    let hasError = false;
    let responded = false;
    
    // Add timeout to prevent hanging queries
    const queryTimeout = setTimeout(() => {
      if (!responded) {
        console.error('[API/DATA] Query timeout after 30 seconds');
        responded = true;
        res.status(504).json({ error: 'Query timeout' });
      }
    }, 30000);
    
    queryApi.queryRows(query, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        data.push({ time: o._time, value: o._value });
        
        // Limit data points to prevent memory bloat
        if (data.length > 10000) {
          console.warn('[API/DATA] Query result too large, truncating');
          if (!responded) {
            clearTimeout(queryTimeout);
            responded = true;
            res.json(data.slice(0, 10000));
          }
          return;
        }
      },
      error(error) {
        console.error('InfluxDB query error:', error);
        clearTimeout(queryTimeout);
        hasError = true;
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Database query error' });
        }
      },
      complete() {
        clearTimeout(queryTimeout);
        if (!hasError && !responded) {
          responded = true;
          res.json(data);
        }
      }
    });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get interfaces from config.json (no SNMP walk needed)
// SNMP polling function for all devices
function pollSNMP() {
  console.log('[POLLING] Function called');
  try {
    const pollTimestamp = new Date(); // Capture timestamp at start of polling cycle
    console.log(`[POLLING] Starting poll at ${pollTimestamp.toISOString()}`);
    
    Object.keys(snmpDevices).forEach(deviceId => {
    const device = snmpDevices[deviceId];
    
    // Track device status - assume device is online at start of polling
    const previousStatus = deviceStatusHistory[deviceId];
    const currentStatus = { alive: true, lastCheck: Date.now() };
    
    // Initialize status history if not exists
    if (!deviceStatusHistory[deviceId]) {
      deviceStatusHistory[deviceId] = currentStatus;
    }
    
    // Check for status changes (device coming online)
    if (previousStatus && !previousStatus.alive) {
      notifyDeviceStatus(deviceId, device.name, 'up', 'Device responded to SNMP polling');
      logEvent('device_online', 'info', device.name, `Device "${device.name}" (${device.host}) is now online`, {
        deviceId: deviceId,
        deviceName: device.name,
        host: device.host
      });
    }
    
    // Update status history
    deviceStatusHistory[deviceId] = currentStatus;
    
    // Skip if no interfaces selected
    if (!device.selectedInterfaces || device.selectedInterfaces.length === 0) {
      console.log(`[${deviceId}] No interfaces selected, skipping polling`);
      return;
    }
    
    console.log(`[${deviceId}] Retrieved ${device.selectedInterfaces.length} interfaces from config`);
    
    // Use selected interfaces directly
    const ifacesToPoll = device.selectedInterfaces.map(iface => {
      if (typeof iface === 'string') {
        // Old format: interface name as string, we need to skip these as they don't have indices
        console.warn(`[${deviceId}] Skipping interface ${iface} - stored as string without index`);
        return null;
      } else {
        // New format: {index, name}
        return {
          index: iface.index,
          name: iface.name
        };
      }
    }).filter(iface => iface !== null); // Remove null entries
    
    ifacesToPoll.forEach(iface => {
      const vendor = device.vendor || 'standard';
      
      // Get appropriate OIDs for this vendor
      const rxOid = `${getVendorOID(vendor, 'ifInOctets')}.${iface.index}`; // RX
      const txOid = `${getVendorOID(vendor, 'ifOutOctets')}.${iface.index}`; // TX
      
      console.log(`[${deviceId}] Using ${vendor} OIDs - RX: ${rxOid}, TX: ${txOid}`);
      
      // Query RX traffic
      snmpSessions[deviceId].get([rxOid], function(rxError, rxVarbinds) {
        if (rxError) {
          console.error(`[${deviceId}] SNMP RX error for interface ${iface.name}:`, rxError);
          // Try fallback to standard MIB-II if vendor-specific OID fails
          if (vendor !== 'standard') {
            const fallbackRxOid = `1.3.6.1.2.1.2.2.1.10.${iface.index}`;
            snmpSessions[deviceId].get([fallbackRxOid], function(fallbackError, fallbackVarbinds) {
              if (!fallbackError && fallbackVarbinds && !snmp.isVarbindError(fallbackVarbinds[0])) {
                console.log(`[${deviceId}] RX fallback successful for ${iface.name}`);
                processRxData(deviceId, device, iface, fallbackVarbinds[0].value, pollTimestamp);
              }
            });
          }
        } else if (snmp.isVarbindError(rxVarbinds[0])) {
          console.error(`[${deviceId}] SNMP RX varbind error for ${iface.name}:`, snmp.varbindError(rxVarbinds[0]));
        } else {
          processRxData(deviceId, device, iface, rxVarbinds[0].value, pollTimestamp);
        }
      });
      
      // Query TX traffic
      snmpSessions[deviceId].get([txOid], function(txError, txVarbinds) {
        if (txError) {
          console.error(`[${deviceId}] SNMP TX error for interface ${iface.name}:`, txError);
          // Try fallback to standard MIB-II if vendor-specific OID fails
          if (vendor !== 'standard') {
            const fallbackTxOid = `1.3.6.1.2.1.2.2.1.16.${iface.index}`;
            snmpSessions[deviceId].get([fallbackTxOid], function(fallbackError, fallbackVarbinds) {
              if (!fallbackError && fallbackVarbinds && !snmp.isVarbindError(fallbackVarbinds[0])) {
                console.log(`[${deviceId}] TX fallback successful for ${iface.name}`);
                processTxData(deviceId, device, iface, fallbackVarbinds[0].value, pollTimestamp);
              }
            });
          }
        } else if (snmp.isVarbindError(txVarbinds[0])) {
          console.error(`[${deviceId}] SNMP TX varbind error for ${iface.name}:`, snmp.varbindError(txVarbinds[0]));
        } else {
          processTxData(deviceId, device, iface, txVarbinds[0].value, pollTimestamp);
        }
      });
    });
    
    // Poll CPU usage for this device
    const vendor = device.vendor || 'standard';
    const cpuOid = getCpuOID(vendor);
    if (cpuOid) {
      console.log(`[${deviceId}] Polling CPU using ${vendor} OID: ${cpuOid}`);
      
      snmpSessions[deviceId].get([cpuOid], function(cpuError, cpuVarbinds) {
        if (cpuError) {
          // Log timeout errors as warnings instead of errors to reduce noise
          if (cpuError.message && cpuError.message.includes('Request timed out')) {
            console.warn(`[${deviceId}] SNMP CPU timeout - skipping CPU polling for this cycle`);
          } else {
            console.error(`[${deviceId}] SNMP CPU error:`, cpuError);
          }
          // Try fallback to standard UCD-SNMP-MIB if vendor-specific OID fails
          if (vendor !== 'standard') {
            const fallbackCpuOid = '1.3.6.1.4.1.2021.11.9.0'; // UCD-SNMP-MIB CPU usage
            snmpSessions[deviceId].get([fallbackCpuOid], function(fallbackError, fallbackVarbinds) {
              if (!fallbackError && fallbackVarbinds && !snmp.isVarbindError(fallbackVarbinds[0])) {
                console.log(`[${deviceId}] CPU fallback successful`);
                let cpuValue = parseFloat(fallbackVarbinds[0].value);
                
                // Mikrotik CPU values are often multiplied by 100, so divide by 100 for percentage
                if (vendor === 'mikrotik' && cpuValue > 100) {
                  cpuValue = cpuValue / 100;
                }
                
                if (!isNaN(cpuValue) && cpuValue >= 0 && cpuValue <= 100) {
                  processCpuData(deviceId, device, cpuValue, pollTimestamp);
                }
              } else {
                // Fallback also failed, skip CPU for this cycle
                if (fallbackError && fallbackError.message && fallbackError.message.includes('Request timed out')) {
                  console.warn(`[${deviceId}] SNMP CPU fallback timeout - CPU data unavailable`);
                } else {
                  console.log(`[${deviceId}] CPU fallback failed or not supported`);
                }
              }
            });
          } else {
            // No fallback available, skip CPU for this cycle
            console.log(`[${deviceId}] CPU polling failed - data unavailable for this cycle`);
          }
        } else if (snmp.isVarbindError(cpuVarbinds[0])) {
          console.error(`[${deviceId}] SNMP CPU varbind error:`, snmp.varbindError(cpuVarbinds[0]));
        } else {
          let cpuValue = parseFloat(cpuVarbinds[0].value);
          
          // Mikrotik CPU values are often multiplied by 100, so divide by 100 for percentage
          if (vendor === 'mikrotik' && cpuValue > 100) {
            cpuValue = cpuValue / 100;
          }
          
          if (!isNaN(cpuValue) && cpuValue >= 0 && cpuValue <= 100) {
            processCpuData(deviceId, device, cpuValue, pollTimestamp);
          } else {
            console.log(`[${deviceId}] Invalid CPU value: ${cpuValue}`);
          }
        }
      });
    } else {
      console.log(`[${deviceId}] No CPU OID available for vendor: ${vendor}`);
    }
  });
  } catch (err) {
    console.error('[POLLING] Error in pollSNMP:', err);
  }
}

// Function to check for device timeouts and mark offline
function checkDeviceTimeouts() {
  const timeoutThreshold = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();
  
  Object.keys(snmpDevices).forEach(deviceId => {
    const device = snmpDevices[deviceId];
    const status = deviceStatusHistory[deviceId];
    
    if (status && status.alive) {
      const timeSinceLastCheck = now - status.lastCheck;
      
      if (timeSinceLastCheck > timeoutThreshold) {
        // Device has not responded for more than threshold, mark as offline
        deviceStatusHistory[deviceId] = {
          alive: false,
          lastCheck: now
        };
        
        notifyDeviceStatus(deviceId, device.name, 'down', `No response for ${Math.round(timeSinceLastCheck / 60000)} minutes`);
        logEvent('device_offline', 'error', device.name, `Device "${device.name}" (${device.host}) is offline - no response for ${Math.round(timeSinceLastCheck / 60000)} minutes`, {
          deviceId: deviceId,
          deviceName: device.name,
          host: device.host,
          timeSinceLastResponse: timeSinceLastCheck
        });
      }
    }
  });
}

// Data retention cleanup function
function cleanupOldData() {
  try {
    const retentionDays = settings.dataRetention || 730;
    const cutoffTime = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
    const cutoffIso = cutoffTime.toISOString();
    
    // Delete data older than retention period
    const deleteQuery = `
      from(bucket: "${settings.influxdb.bucket}")
        |> range(start: 1970-01-01T00:00:00Z, stop: ${cutoffIso})
        |> delete()
    `;
    
    const deleteApi = client.deleteAPI();
    deleteApi.delete(cutoffTime.getTime(), new Date().getTime(), `_measurement="snmp_metric"`, settings.influxdb.bucket, settings.influxdb.org);
    
    console.log(`\n[DATA RETENTION] Cleanup executed - Removed data older than ${retentionDays} days (cutoff: ${cutoffIso})\n`);
  } catch (err) {
    console.error('[DATA RETENTION] Cleanup error:', err);
  }
}

// Schedule daily data cleanup
function scheduleDataCleanup() {
  // Run cleanup every day at 2 AM
  const now = new Date();
  const scheduledTime = new Date();
  scheduledTime.setHours(2, 0, 0, 0);
  
  // If it's already past 2 AM, schedule for tomorrow
  if (now > scheduledTime) {
    scheduledTime.setDate(scheduledTime.getDate() + 1);
  }
  
  const timeUntilCleanup = scheduledTime.getTime() - now.getTime();
  
  setTimeout(() => {
    cleanupOldData();
    // Then schedule it to run every 24 hours
    setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
  }, timeUntilCleanup);
  
  console.log(`[DATA RETENTION] Daily cleanup scheduled for ${scheduledTime.toLocaleTimeString()}`);
}

// Polling interval management
let pollInterval;

function startPolling() {
  console.log(`[START POLLING] Settings pollingInterval: ${settings.pollingInterval} (type: ${typeof settings.pollingInterval})`);
  console.log(`[START POLLING] About to call setInterval with ${settings.pollingInterval}ms`);
  pollInterval = setInterval(pollSNMP, settings.pollingInterval);
  console.log(`[START POLLING] setInterval created with ID: ${pollInterval}`);
  console.log(`\n[POLLING] Started - Interval: ${settings.pollingInterval / 1000} seconds (${settings.pollingInterval / 60000} minutes)\n`);
}

function restartPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  startPolling();
}

// Start SNMP polling
let pollingIntervalId = null;

// Start polling with configured interval
startPolling();

// Start data retention cleanup scheduler
scheduleDataCleanup();

// System information API endpoint
app.get('/api/system-info', (req, res) => {
  const os = require('os');
  
  // Get system uptime
  const uptime = os.uptime();
  const uptimeDays = Math.floor(uptime / 86400);
  const uptimeHours = Math.floor((uptime % 86400) / 3600);
  const uptimeMinutes = Math.floor((uptime % 3600) / 60);
  const uptimeString = `${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m`;
  
  // Get memory info
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  
  // Get CPU info
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  
  // Simple CPU usage estimation (this is approximate)
  let totalIdle = 0;
  let totalTick = 0;
  cpus.forEach(cpu => {
    for (let type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const cpuUsage = Math.round(100 - ~~(100 * idle / total));
  
  // Get platform info
  const platform = os.platform() + ' ' + os.arch();
  
  // Get storage info (disk usage)
  let storageInfo = { total: 0, used: 0, free: 0, percent: 0 };
  try {
    const { execSync } = require('child_process');
    const dfOutput = execSync('df -B1 / | tail -1').toString();
    const parts = dfOutput.split(/\s+/);
    if (parts.length >= 5) {
      storageInfo.total = parseInt(parts[1]);
      storageInfo.used = parseInt(parts[2]);
      storageInfo.free = parseInt(parts[3]);
      storageInfo.percent = parseInt(parts[4].replace('%', ''));
    }
  } catch (err) {
    console.error('Error getting storage info:', err);
  }
  
  res.json({
    nodeVersion: process.version,
    platform: platform,
    uptime: uptimeString,
    memory: {
      total: totalMemory,
      used: usedMemory,
      free: freeMemory
    },
    cpuCores: cpuCount,
    cpuUsage: Math.max(0, Math.min(100, cpuUsage)), // Ensure between 0-100
    storage: storageInfo
  });
});

// Ping monitoring function
function startPingMonitoring() {
  console.log('[PING] Starting ping monitoring for', pingTargets.length, 'targets');

  pingTargets.forEach(target => {
    if (!target.enabled) return;

    ping.promise.probe(target.host, {
      timeout: 5,
      min_reply: 1,
      deadline: 10
    }).then(result => {
      // Check for status changes and send notifications
      const previousStatus = pingStatusHistory[target.id];
      const currentLatency = parseFloat(result.time) || 0;
      const currentPacketLoss = parseFloat(result.packetLoss) || 0;
      const isAlive = result.alive;

      // Initialize status history if not exists
      if (!pingStatusHistory[target.id]) {
        pingStatusHistory[target.id] = {
          alive: isAlive,
          lastLatency: currentLatency,
          lastPacketLoss: currentPacketLoss,
          lastCheck: Date.now()
        };
      }

      // Check for status changes
      if (previousStatus) {
        // Target went from down to up
        if (!previousStatus.alive && isAlive) {
          notifyPingStatus(target.id, target.name, target.host, 'up', currentLatency, currentPacketLoss);
        }
        // Target went from up to down
        else if (previousStatus.alive && !isAlive) {
          notifyPingStatus(target.id, target.name, target.host, 'down', currentLatency, currentPacketLoss);
        }
        // Check for timeout (high packet loss)
        else if (isAlive && currentPacketLoss >= 100) {
          notifyPingStatus(target.id, target.name, target.host, 'timeout', currentLatency, currentPacketLoss);
        }
        // Check for high latency
        else if (isAlive && currentLatency > 0) {
          notifyPingStatus(target.id, target.name, target.host, 'high_latency', currentLatency, currentPacketLoss);
        }
      }

      // Update status history
      pingStatusHistory[target.id] = {
        alive: isAlive,
        lastLatency: currentLatency,
        lastPacketLoss: currentPacketLoss,
        lastCheck: Date.now()
      };

      addPingToDatabase(target.id, result);
    }).catch(err => {
      console.error(`[PING] Error pinging ${target.name} (${target.host}):`, err);

      // Check for status changes on error
      const previousStatus = pingStatusHistory[target.id];
      if (previousStatus && previousStatus.alive) {
        // Target was alive but now has error (treat as down)
        notifyPingStatus(target.id, target.name, target.host, 'down', 0, 100);
      }

      // Update status history for failed ping
      pingStatusHistory[target.id] = {
        alive: false,
        lastLatency: 0,
        lastPacketLoss: 100,
        lastCheck: Date.now()
      };

      // Still record the failed ping
      addPingToDatabase(target.id, {
        time: 0,
        packetLoss: 100,
        alive: false
      });
    });
  });
}

// Start ping monitoring
setInterval(startPingMonitoring, settings.pingInterval);

// API endpoint for ping test
app.post('/api/ping-test', (req, res) => {
  const { targetId } = req.body;

  if (!targetId) {
    return res.status(400).json({ error: 'Target ID is required' });
  }

  const target = pingTargets.find(t => t.id === parseInt(targetId));
  if (!target) {
    return res.status(404).json({ error: 'Target not found' });
  }

  ping.promise.probe(target.host, {
    timeout: 5,
    min_reply: 1,
    deadline: 10
  }).then(result => {
    addPingToDatabase(target.id, result);
    res.json({
      targetId: target.id,
      targetName: target.name,
      host: target.host,
      alive: result.alive,
      time: result.time,
      packetLoss: result.packetLoss
    });
  }).catch(err => {
    console.error(`[PING API] Error testing ping for ${target.name}:`, err);
    res.status(500).json({ error: 'Ping test failed' });
  });
});

// API endpoint for ping history
app.get('/api/ping-history/:targetId', async (req, res) => {
  const { targetId } = req.params;

  try {
    const queryApi = client.getQueryApi(settings.influxdb.org);

    const fluxQuery = `
      from(bucket: "${settings.influxdb.bucket}")
      |> range(start: -30d)
      |> filter(fn: (r) => r._measurement == "ping_metric")
      |> filter(fn: (r) => r.target_id == "${targetId}")
      |> filter(fn: (r) => r._field == "latency" or r._field == "packet_loss" or r._field == "alive")
      |> sort(columns: ["_time"])
    `;

    const result = await queryApi.collectRows(fluxQuery);

    // Process the data
    const data = {};
    result.forEach(row => {
      const time = new Date(row._time).getTime();
      if (!data[time]) {
        data[time] = {
          time: time,
          latency: null,
          packetLoss: null,
          alive: null
        };
      }
      data[time][row._field] = row._value;
    });

    const processedData = Object.values(data).sort((a, b) => a.time - b.time);

    res.json({
      targetId: parseInt(targetId),
      data: processedData
    });
  } catch (err) {
    console.error('[PING API] Error fetching ping history:', err);
    res.status(500).json({ error: 'Failed to fetch ping history' });
  }
});

// API endpoint for event history
app.get('/api/history', (req, res) => {
  try {
    res.json({
      events: eventHistory
    });
  } catch (err) {
    console.error('Error fetching event history:', err);
    res.status(500).json({ error: 'Failed to fetch event history' });
  }
});

// API endpoint to clear event history
app.delete('/api/history', (req, res) => {
  try {
    eventHistory = [];
    saveHistory();
    res.json({
      success: true,
      message: 'Event history cleared successfully'
    });
  } catch (err) {
    console.error('Error clearing event history:', err);
    res.status(500).json({ error: 'Failed to clear event history' });
  }
});

// Start SNMP polling

function startPolling() {
  if (pollingIntervalId) {
    clearInterval(pollingIntervalId);
  }
  
  console.log(`[POLLING] Starting SNMP polling with interval: ${settings.pollingInterval}ms`);
  pollingIntervalId = setInterval(pollSNMP, settings.pollingInterval);
  
  // Also start device timeout checking
  setInterval(checkDeviceTimeouts, 60000); // Check every minute
  
  // Run initial poll
  setTimeout(pollSNMP, 1000);
}

function restartPolling() {
  console.log('[POLLING] Restarting polling with new interval');
  startPolling();
}

// Start polling on application startup
startPolling();

const webpush = require('web-push');

// VAPID keys for push notifications (generate these in production)
const vapidKeys = {
  publicKey: 'BMrGTYW-3IXNMtQRgIoqSs9qzf4yQaDFmB86kBdhebfJr1BNa1ViUzt7UwEtz3uGAmHtqwSvkW_0frk6tnY2CUM',
  privateKey: 'j3LPTIziZlw3bh1O8GnTsbL0gt0qOreFnQ0sy0RdNYY'
};

// Configure web-push
webpush.setVapidDetails(
  'mailto:admin@smon.local',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Store push subscriptions (in production, use a database)
let pushSubscriptions = [];

// API to get VAPID public key
app.get('/api/push-key', (req, res) => {
  res.json({
    publicKey: vapidKeys.publicKey
  });
});

// API to subscribe to push notifications
app.post('/api/push-subscribe', (req, res) => {
  try {
    const subscription = req.body;

    // Check if subscription already exists
    const existingIndex = pushSubscriptions.findIndex(sub =>
      sub.endpoint === subscription.endpoint
    );

    if (existingIndex === -1) {
      pushSubscriptions.push(subscription);
      console.log('[PUSH] New subscription added');
    } else {
      // Update existing subscription
      pushSubscriptions[existingIndex] = subscription;
      console.log('[PUSH] Subscription updated');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[PUSH] Subscription error:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// API to send push notification (for testing)
app.post('/api/push-test', (req, res) => {
  try {
    const { title, body, type } = req.body;

    sendPushNotificationToAll({
      title: title || 'Test Notification',
      body: body || 'This is a test push notification from SMon',
      type: type || 'test'
    });

    res.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    console.error('[PUSH] Test notification error:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// Function to send push notification to all subscribers
function sendPushNotificationToAll(data) {
  const payload = JSON.stringify({
    title: data.title,
    body: data.body,
    type: data.type,
    url: data.url || '/',
    timestamp: Date.now()
  });

  pushSubscriptions.forEach((subscription, index) => {
    webpush.sendNotification(subscription, payload)
      .catch((error) => {
        console.error('[PUSH] Send failed, removing subscription:', error);
        // Remove invalid subscriptions
        pushSubscriptions.splice(index, 1);
      });
  });
}

// Enhanced notification functions to include push notifications
const originalNotifyDeviceStatus = notifyDeviceStatus;
notifyDeviceStatus = function(deviceId, deviceName, status, details = '') {
  // Call original function
  originalNotifyDeviceStatus(deviceId, deviceName, status, details);

  // Send push notification
  if (pushSubscriptions.length > 0) {
    let title, body, type;
    if (status === 'up') {
      title = 'Device Online';
      body = `${deviceName} is back online`;
      type = 'device_up';
    } else if (status === 'down') {
      title = 'Device Offline';
      body = `${deviceName} is offline`;
      type = 'device_down';
    }

    if (title) {
      sendPushNotificationToAll({
        title,
        body,
        type,
        url: '/devices'
      });
    }
  }
};

const originalNotifyHighCpu = notifyHighCpu;
notifyHighCpu = function(deviceId, deviceName, cpuValue) {
  // Call original function
  originalNotifyHighCpu(deviceId, deviceName, cpuValue);

  // Send push notification
  if (pushSubscriptions.length > 0) {
    sendPushNotificationToAll({
      title: 'High CPU Alert',
      body: `${deviceName} CPU usage: ${cpuValue}%`,
      type: 'high_cpu',
      url: '/devices'
    });
  }
};

const originalNotifyPingStatus = notifyPingStatus;
notifyPingStatus = function(targetId, targetName, targetHost, status, latency = null, packetLoss = null) {
  // Call original function
  originalNotifyPingStatus(targetId, targetName, targetHost, status, latency, packetLoss);

  // Send push notification
  if (pushSubscriptions.length > 0) {
    let title, body, type;
    if (status === 'down') {
      title = 'Ping Target Down';
      body = `${targetName} (${targetHost}) is unreachable`;
      type = 'ping_down';
    } else if (status === 'up') {
      title = 'Ping Target Up';
      body = `${targetName} (${targetHost}) is back online`;
      type = 'ping_up';
    } else if (status === 'high_latency') {
      title = 'High Latency Alert';
      body = `${targetName} latency: ${latency}ms`;
      type = 'high_latency';
    }

    if (title) {
      sendPushNotificationToAll({
        title,
        body,
        type,
        url: '/ping'
      });
    }
  }
};

// API for offline data sync
app.post('/api/sync-offline-data', (req, res) => {
  try {
    const offlineData = req.body;
    console.log('[SYNC] Received offline data:', offlineData);

    // Process offline data (in production, save to database)
    // For now, just log it
    logEvent('offline_sync', 'info', 'System', `Offline data synced: ${JSON.stringify(offlineData)}`);

    res.json({ success: true });
  } catch (error) {
    console.error('[SYNC] Offline data sync error:', error);
    res.status(500).json({ error: 'Failed to sync offline data' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);

  // Start ping monitoring immediately
  startPingMonitoring();
});


