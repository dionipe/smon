const express = require('express');
const path = require('path');
const fs = require('fs');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const snmp = require('net-snmp');
const ping = require('ping');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const os = require('os');
const https = require('https');
const http = require('http');
const tls = require('tls');

const app = express();
const port = 3000;

// Counter rollover tracking for bandwidth calculations
// Key format: `${deviceId}_${interfaceIndex}_${direction}`
let lastCounterValues = {};

// Track detected high-speed interfaces to apply enhanced multi-wrap detection
// Key format: `${deviceId}_${interfaceIndex}`, value: estimated speed in Mbps
let highSpeedInterfaces = {};

// Track which devices have valid CPU SNMP support
// Key: deviceId, value: {hasCpu: boolean, lastAttempt: timestamp}
let deviceCpuStatus = {};

// Counter rollover detection and adjustment
function handleCounterRollover(deviceId, iface, direction, currentValue) {
  const key = `${deviceId}_${iface.index}_${direction}`;
  const previousValue = lastCounterValues[key];
  const max32Bit = 4294967295; // 2^32 - 1
  const max64Bit = 18446744073709551615; // 2^64 - 1

  // Initialize if first reading
  if (previousValue === undefined) {
    lastCounterValues[key] = currentValue;
    return 0; // Return 0 for first reading (no delta to calculate)
  }

  // NORMAL CASE: current > previous (no rollover)
  if (currentValue >= previousValue) {
    const delta = currentValue - previousValue;
    lastCounterValues[key] = currentValue;
    return delta;
  }

  // ROLLOVER DETECTED: current < previous
  // This is the key case for high-speed traffic where counter wraps around
  const actualDrop = previousValue - currentValue;

  // Multi-wrap detection strategy:
  // For 32-bit counters with high-speed interfaces:
  // - If previous is NEAR 32-bit max and current wraps to small value: 1 wrap
  // - If previous is NOT near max and we see large drop: possible multiple wraps

  // Pattern 1: Classic single wrap (previous ~4.29GB, current wraps to small)
  if (previousValue > max32Bit * 0.8) {
    // Previous was near the top, so single wrap is likely
    const singleWrap = max32Bit - previousValue + currentValue;
    if (singleWrap > 0) {
      lastCounterValues[key] = currentValue;
      return singleWrap;
    }
  }

  // Pattern 2: Multiple wraps (previous lower value, but large drop suggests multi-wrap)
  // For 1Gbps traffic on 60-sec poll: need ~125MB per cycle
  // Multiple wraps would show: previous=X, current=Y, and (prev - curr) is large

  // If actualDrop > 1GB (which is impossible in single wrap), definitely multi-wrap
  if (actualDrop > 1000000000) { // 1GB
    // Multiple wraps occurred
    // Calculate wraps assuming each wrap adds 32-bit max to the count
    let wraps = Math.ceil(actualDrop / max32Bit);
    let adjustedDelta = (wraps * max32Bit) - previousValue + currentValue;

    console.log(`[${deviceId}] MULTI-WRAP DETECTED for ${iface.name} ${direction.toUpperCase()}: prev=${previousValue}, curr=${currentValue}, drop=${(actualDrop / 1000000000).toFixed(2)}GB, wraps=${wraps}, adjusted=${(adjustedDelta / 1000000000).toFixed(2)}GB`);
    lastCounterValues[key] = currentValue;
    return adjustedDelta;
  }

  // Pattern 3: Significant drop but < 1GB - likely single wrap
  // Use standard wrap formula
  const singleWrapDelta = max32Bit - previousValue + currentValue;
  if (singleWrapDelta > 0 && singleWrapDelta < max32Bit * 2) {
    lastCounterValues[key] = currentValue;
    return singleWrapDelta;
  }

  // Pattern 4: 64-bit wrap check
  const drop64Bit = max64Bit - previousValue + currentValue;
  if (drop64Bit > 0 && drop64Bit < max64Bit * 0.05) {
    console.log(`[${deviceId}] 64-bit wrap for ${iface.name} ${direction.toUpperCase()}: ${(drop64Bit / 1000000000).toFixed(2)}GB`);
    lastCounterValues[key] = currentValue;
    return drop64Bit;
  }

  // Pattern 5: Interface reset detection
  if (currentValue < 1000000) { // < 1MB likely reset
    console.warn(`[${deviceId}] Interface reset for ${iface.name} ${direction.toUpperCase()}: ${previousValue} -> ${currentValue}`);
    lastCounterValues[key] = currentValue;
    return 0;
  }

  // Default: treat drop as legitimate high-speed traffic
  console.log(`[${deviceId}] Counter drop for ${iface.name} ${direction.toUpperCase()}: prev=${previousValue}, curr=${currentValue}, drop=${(actualDrop / 1000000000).toFixed(2)}GB`);
  lastCounterValues[key] = currentValue;
  return actualDrop;
}

// Cleanup old counter values to prevent memory leaks
function cleanupCounterHistory() {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  // This is a simple cleanup - in production you might want more sophisticated tracking
  // For now, we'll just clear all counters periodically to force re-initialization
  // This ensures we don't accumulate stale data indefinitely
  if (Object.keys(lastCounterValues).length > 1000) { // Arbitrary limit
    console.log('[COUNTER CLEANUP] Clearing counter history to prevent memory leaks');
    lastCounterValues = {};
  }
}

// Function to get SSL certificate information
function getSSLCertificate(hostname, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port: port,
      servername: hostname, // SNI
      rejectUnauthorized: false
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert);
    });

    socket.on('error', (err) => {
      reject(err);
    });

    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('SSL certificate check timeout'));
    });
  });
}

// Vendor OID mappings for different network device vendors
const VENDOR_OIDS = {
  // Standard MIB-II (works on most devices)
  standard: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',      // Interface description
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',  // Inbound octets
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16', // Outbound octets
    sysDescr: '1.3.6.1.2.1.1.1.0',        // System description
    cpuUsage: '1.3.6.1.4.1.2021.11.9.0',   // UCD-SNMP-MIB CPU usage (percentage)
    // Standard 64-bit counters (High Capacity)
    ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
    ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10'
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
    // Map standard HC names to Mikrotik OIDs
    ifHCInOctets: '1.3.6.1.4.1.14988.1.1.14.1.1.6',
    ifHCOutOctets: '1.3.6.1.4.1.14988.1.1.14.1.1.10',
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
  },
  // Fortigate specific OIDs (FORTINET-FORTIGATE-MIB)
  fortigate: {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    sysDescr: '1.3.6.1.2.1.1.1.0',
    // Fortigate specific metrics
    fgSysCpuUsage: '1.3.6.1.4.1.12356.101.4.1.3.0',        // CPU usage percentage
    fgSysMemUsage: '1.3.6.1.4.1.12356.101.4.1.4.0',        // Memory usage percentage
    fgSysUptime: '1.3.6.1.4.1.12356.101.4.1.1.0',          // System uptime (sysUpTime)
    fgSysSerialNumber: '1.3.6.1.4.1.12356.101.4.1.2.0',    // Serial number
    fgHaStatus: '1.3.6.1.4.1.12356.101.13.2.1.0',          // HA (High Availability) status
    fgHaMasterSerial: '1.3.6.1.4.1.12356.101.13.2.1.2.0',  // HA master serial number
    fgHaSlaveSerial: '1.3.6.1.4.1.12356.101.13.2.1.3.0'    // HA slave serial number
  }
};

// Function to detect device vendor based on sysDescr
function detectVendor(sysDescr) {
  const descr = sysDescr.toLowerCase();

  if (descr.includes('fortigate') || descr.includes('fortinet')) return 'fortigate';
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
    case 'fortigate':
      return vendorConfig['fgSysCpuUsage'];
    default:
      return vendorConfig['cpuUsage']; // Standard UCD-SNMP
  }
}

// Function to process RX data
function processRxData(deviceId, device, iface, rxValue, timestamp = new Date()) {
  try {
    // Handle counter rollover and get the actual delta
    const rxDelta = handleCounterRollover(deviceId, iface, 'rx', rxValue);

    // Skip writing for first reading (delta = 0) to avoid 0 Mbps drop on service restart
    if (rxDelta === 0) {
      console.log(`[${deviceId}] RX first reading for ${iface.name}, skipping write`);
      return;
    }

    // Log high-traffic interfaces for debugging
    if (rxDelta > 500000000) { // > 500MB delta
      const deltaGb = (rxDelta / 1000000000).toFixed(2);
      const estimatedMbps = ((rxDelta * 8 / 1000000) / (settings.pollingInterval / 1000)).toFixed(2);
      console.log(`[${deviceId}] HIGH-SPEED RX for ${iface.name}: counter=${rxValue}, delta=${deltaGb}GB (~${estimatedMbps}Mbps estimate)`);

      // Track as high-speed interface for better multi-wrap detection
      const ifKey = `${deviceId}_${iface.index}`;
      if (!highSpeedInterfaces[ifKey] || highSpeedInterfaces[ifKey] < estimatedMbps) {
        highSpeedInterfaces[ifKey] = estimatedMbps;
        console.log(`[${deviceId}] Interface ${iface.name} marked as HIGH-SPEED (${estimatedMbps} Mbps)`);
      }
    }

    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const rxPoint = new Point('snmp_metric')
      .tag('device', deviceId)
      .tag('device_name', device.name)
      .tag('interface', iface.name)
      .tag('direction', 'rx')
      .tag('vendor', device.vendor || 'standard')
      .timestamp(timestamp)
      .floatField('value', rxDelta);
    writeApi.writePoint(rxPoint);
    writeApi.close().then(() => {
      console.log(`[${deviceId}] RX data written for ${iface.name}: ${rxDelta} octets`);
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
    // Handle counter rollover and get the actual delta
    const txDelta = handleCounterRollover(deviceId, iface, 'tx', txValue);

    // Skip writing for first reading (delta = 0) to avoid 0 Mbps drop on service restart
    if (txDelta === 0) {
      console.log(`[${deviceId}] TX first reading for ${iface.name}, skipping write`);
      return;
    }

    // Log high-traffic interfaces for debugging
    if (txDelta > 500000000) { // > 500MB delta
      const deltaGb = (txDelta / 1000000000).toFixed(2);
      const estimatedMbps = ((txDelta * 8 / 1000000) / (settings.pollingInterval / 1000)).toFixed(2);
      console.log(`[${deviceId}] HIGH-SPEED TX for ${iface.name}: counter=${txValue}, delta=${deltaGb}GB (~${estimatedMbps}Mbps estimate)`);

      // Track as high-speed interface for better multi-wrap detection
      const ifKey = `${deviceId}_${iface.index}`;
      if (!highSpeedInterfaces[ifKey] || highSpeedInterfaces[ifKey] < estimatedMbps) {
        highSpeedInterfaces[ifKey] = estimatedMbps;
        console.log(`[${deviceId}] Interface ${iface.name} marked as HIGH-SPEED (${estimatedMbps} Mbps)`);
      }
    }

    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const txPoint = new Point('snmp_metric')
      .tag('device', deviceId)
      .tag('device_name', device.name)
      .tag('interface', iface.name)
      .tag('direction', 'tx')
      .tag('vendor', device.vendor || 'standard')
      .timestamp(timestamp)
      .floatField('value', txDelta);
    writeApi.writePoint(txPoint);
    writeApi.close().then(() => {
      console.log(`[${deviceId}] TX data written for ${iface.name}: ${txDelta} octets`);
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

function notifyWebsiteStatus(targetId, targetName, targetUrl, status, responseTime = null, sslDaysRemaining = null) {
  if (!settings.telegram || !settings.telegram.enabled) return;

  const timestamp = new Date().toLocaleString('id-ID');
  let message = '';
  let shouldNotify = false;

  if (status === 'down' && settings.website.notifyOnDown) {
    message = `🔴 <b>Website Down Alert</b>\n\n` +
      `🌐 <b>Website:</b> ${targetName} (${targetUrl})\n` +
      `⏰ <b>Time:</b> ${timestamp}\n` +
      `❌ <b>Status:</b> Website is unreachable\n` +
      `🚨 <b>Alert:</b> Website is down!`;
    shouldNotify = true;

    // Log website down event
    logEvent('website_down', 'error', targetName, `Website "${targetName}" (${targetUrl}) is down`, {
      targetId: targetId,
      targetName: targetName,
      url: targetUrl
    });
  } else if (status === 'up' && settings.website.notifyOnUp) {
    message = `🟢 <b>Website Up Alert</b>\n\n` +
      `🌐 <b>Website:</b> ${targetName} (${targetUrl})\n` +
      `⏰ <b>Time:</b> ${timestamp}\n` +
      `✅ <b>Status:</b> Website is back online\n` +
      `⚡ <b>Response Time:</b> ${responseTime}ms\n` +
      `🎉 <b>Alert:</b> Website recovered!`;
    shouldNotify = true;

    // Log website up event
    logEvent('website_up', 'info', targetName, `Website "${targetName}" (${targetUrl}) is back online`, {
      targetId: targetId,
      targetName: targetName,
      url: targetUrl,
      responseTime: responseTime
    });
  } else if (status === 'ssl_expiry_warning' && settings.website.notifyOnSslExpiry) {
    message = `🔐 <b>SSL Certificate Expiry Warning</b>\n\n` +
      `🌐 <b>Website:</b> ${targetName} (${targetUrl})\n` +
      `⏰ <b>Time:</b> ${timestamp}\n` +
      `⏰ <b>Days Remaining:</b> ${sslDaysRemaining} days\n` +
      `🚨 <b>Alert:</b> SSL certificate expires soon!`;
    shouldNotify = true;

    // Log SSL expiry warning event
    logEvent('ssl_expiry_warning', 'warning', targetName, `SSL certificate for "${targetName}" (${targetUrl}) expires in ${sslDaysRemaining} days`, {
      targetId: targetId,
      targetName: targetName,
      url: targetUrl,
      daysRemaining: sslDaysRemaining
    });
  }

  if (shouldNotify && message) {
    sendTelegramMessage(message);
    // TODO: Add email notification for website status
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

// Load package.json for version information
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
app.locals.version = packageJson.version;

// Cookie parser middleware
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Authentication middleware
const requireAuth = (req, res, next) => {
  const isAuthenticated = req.cookies.authenticated === 'true';
  if (isAuthenticated || req.path === '/login' || req.path === '/about' || req.path === '/status' || req.path.startsWith('/api/') || req.path === '/metrics') {
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
const pingTargetsFile = './data/ping-targets.json';
if (fs.existsSync(pingTargetsFile)) {
  pingTargets = JSON.parse(fs.readFileSync(pingTargetsFile, 'utf8'));
} else {
  fs.writeFileSync(pingTargetsFile, JSON.stringify(pingTargets, null, 2));
}

// Domain monitoring configuration
let domainTargets = [
  { id: 1, name: 'example.com', registrar: 'GoDaddy', expiration_date: '2025-12-31T23:59:59Z', auto_renew: true, group: 'Business', enabled: true },
  { id: 2, name: 'testdomain.org', registrar: 'Namecheap', expiration_date: '2025-06-15T23:59:59Z', auto_renew: false, group: 'Personal', enabled: true }
];

// Domain status tracking
let domainStatusHistory = {}; // Track domain status changes

// Load or create domain targets file
const domainTargetsFile = './domain-targets.json';
if (fs.existsSync(domainTargetsFile)) {
  domainTargets = JSON.parse(fs.readFileSync(domainTargetsFile, 'utf8'));
} else {
  fs.writeFileSync(domainTargetsFile, JSON.stringify(domainTargets, null, 2));
}

// Website monitoring configuration
let websiteTargets = [
  { id: 1, name: 'Google', url: 'https://www.google.com', group: 'Search Engines', enabled: true },
  { id: 2, name: 'GitHub', url: 'https://github.com', group: 'Development', enabled: true }
];

// Website status tracking for notifications
let websiteStatusHistory = {}; // Track previous website status for each target

// Load or create website targets file
const websiteTargetsFile = './website-targets.json';
if (fs.existsSync(websiteTargetsFile)) {
  websiteTargets = JSON.parse(fs.readFileSync(websiteTargetsFile, 'utf8'));
} else {
  fs.writeFileSync(websiteTargetsFile, JSON.stringify(websiteTargets, null, 2));
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

// ============================================
// TOPOLOGY MAP MANAGEMENT
// ============================================

const topologyFile = './data/topology.json';

let topology = {
  nodes: [],
  links: [],
  views: []
};

function loadTopology() {
  try {
    if (fs.existsSync(topologyFile)) {
      const data = fs.readFileSync(topologyFile, 'utf8');
      topology = JSON.parse(data);
      console.log(`✓ Topology loaded: ${topology.nodes.length} nodes, ${topology.links.length} links`);

      // Initialize ping targets for topology nodes
      initializeTopologyPingTargets();
    } else {
      console.log('ℹ No topology.json found - using empty topology');
      topology = { nodes: [], links: [], views: [] };
    }
  } catch (err) {
    console.error('Error loading topology:', err.message);
    topology = { nodes: [], links: [], views: [] };
  }
}

function initializeTopologyPingTargets() {
  // Add topology nodes to ping targets if they have probe settings
  for (const node of topology.nodes) {
    if (node.probeType === 'ping' && node.probeTarget) {
      // Check if this target already exists
      const exists = pingTargets.some(t => t.host === node.probeTarget);
      if (!exists) {
        const newId = Math.max(...pingTargets.map(t => t.id || 0), 0) + 1;
        pingTargets.push({
          id: newId,
          name: node.label,
          host: node.probeTarget,
          group: 'Topology',
          enabled: true,
          sourceNodeId: node.id  // Track source node for reference
        });
        console.log(`✓ Added topology node to ping targets: ${node.label} (${node.probeTarget})`);
      }
    }
  }

  // Save updated ping targets
  savePingTargets();
}

function savePingTargets() {
  try {
    const pingTargetsFile = './data/ping-targets.json';
    fs.writeFileSync(pingTargetsFile, JSON.stringify(pingTargets, null, 2));
  } catch (err) {
    console.error('Error saving ping targets:', err.message);
  }
}

function saveTopology() {
  try {
    // Ensure data directory exists
    if (!fs.existsSync('./data')) {
      fs.mkdirSync('./data', { recursive: true });
    }
    fs.writeFileSync(topologyFile, JSON.stringify(topology, null, 2));
    console.log('✓ Topology saved');
  } catch (err) {
    console.error('Error saving topology:', err.message);
  }
}
// Get real-time status of topology nodes and links
function getTopologyStatus() {
  const nodeStatus = {};
  const linkStatus = {};

  // Get node status from ping history and ping targets
  for (const node of topology.nodes) {
    if (node.probeType === 'ping' && node.probeTarget) {
      const pingTarget = pingTargets.find(t => t.host === node.probeTarget || t.host === node.ip);
      if (pingTarget && pingStatusHistory[pingTarget.id]) {
        const history = pingStatusHistory[pingTarget.id];

        // Convert alive boolean to status string
        let status = 'unknown';
        if (history.alive === true) {
          status = 'up';
        } else if (history.alive === false) {
          status = 'down';
        }

        nodeStatus[node.id] = {
          status: status,
          latency: history.lastLatency || history.latency || 0,
          packetLoss: history.lastPacketLoss || history.packetLoss || 0,
          lastUpdate: new Date().toISOString()
        };
      } else {
        nodeStatus[node.id] = {
          status: 'unknown',
          latency: 0,
          packetLoss: 0,
          lastUpdate: new Date().toISOString()
        };
      }
    }
  }

  // Get link status based on connected nodes
  for (const link of topology.links) {
    const sourceStatus = nodeStatus[link.source]?.status || 'unknown';
    const targetStatus = nodeStatus[link.target]?.status || 'unknown';

    let quality = 'unknown';
    if (sourceStatus === 'up' && targetStatus === 'up') {
      const sourceLatency = nodeStatus[link.source]?.latency || 0;
      const targetLatency = nodeStatus[link.target]?.latency || 0;
      const avgLatency = (sourceLatency + targetLatency) / 2;

      if (avgLatency > (link.latencyThreshold || 100)) {
        quality = 'warning';
      } else {
        quality = 'good';
      }
    } else if (sourceStatus === 'down' || targetStatus === 'down') {
      quality = 'critical';
    }

    linkStatus[link.id] = {
      status: sourceStatus === 'up' && targetStatus === 'up' ? 'up' : 'down',
      quality: quality,
      sourceLatency: nodeStatus[link.source]?.latency || 0,
      targetLatency: nodeStatus[link.target]?.latency || 0,
      lastUpdate: new Date().toISOString()
    };
  }

  return { nodes: nodeStatus, links: linkStatus };
}

// Helper function to save website targets
function saveWebsiteTargets() {
  fs.writeFileSync(websiteTargetsFile, JSON.stringify(websiteTargets, null, 2));
  console.log('Website targets saved');
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
    title: 'Dashboard',
    devices: snmpDevices,
    interfaces: allInterfaces,
    pingTargets: safePingTargets,
    groupedPingTargets: groupedPingTargets,
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for device management page
app.get('/devices', (req, res) => {
  res.render('devices', {
    title: 'Devices',
    devices: snmpDevices
  });
});

// Route for settings page
app.get('/settings', (req, res) => {
  res.render('settings', {
    title: 'Settings',
    settings: settings,
    devices: snmpDevices,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for history page
app.get('/history', (req, res) => {
  res.render('history', {
    title: 'History',
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for about page
app.get('/about', (req, res) => {
  res.render('about', {
    title: 'About',
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for public status page (no authentication required)
app.get('/status', (req, res) => {
  res.render('status', {
    title: 'System Status - SMon',
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
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
    title: 'Ping Monitor',
    pingTargets: pingTargets,
    groupedTargets: groupedTargets,
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for domain monitoring page
app.get('/domains', (req, res) => {
  // Group domain targets by group
  const groupedTargets = {};
  domainTargets.forEach(target => {
    if (!groupedTargets[target.group]) {
      groupedTargets[target.group] = [];
    }
    groupedTargets[target.group].push(target);
  });

  res.render('domains', {
    title: 'Domain Monitor',
    domainTargets: domainTargets,
    groupedTargets: groupedTargets,
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Route for website monitoring page
app.get('/websites', (req, res) => {
  // Group website targets by group
  const groupedTargets = {};
  websiteTargets.forEach(target => {
    if (!groupedTargets[target.group]) {
      groupedTargets[target.group] = [];
    }
    groupedTargets[target.group].push(target);
  });

  res.render('websites', {
    title: 'Website Monitor',
    websiteTargets: websiteTargets,
    groupedTargets: groupedTargets,
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Network Topology Map Page
app.get('/map', (req, res) => {
  res.render('map', {
    title: 'Topology Map',
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
  });
});

// Network Weathermap Page
app.get('/weathermap', (req, res) => {
  res.render('weathermap', {
    title: 'Network Weathermap',
    settings: settings,
    pollingIntervalSeconds: settings.pollingInterval / 1000,
    pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
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

    // Log the event
    logEvent('ping_target_added', 'info', 'Ping Monitor', `Ping target "${newTarget.name}" (${newTarget.host}) added to group "${newTarget.group}"`, {
      targetId: newTarget.id,
      targetName: newTarget.name,
      targetHost: newTarget.host,
      targetGroup: newTarget.group
    });

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

    const target = pingTargets[index]; // Capture target data before deletion
    pingTargets.splice(index, 1);
    savePingTargets();

    // Log the event
    logEvent('ping_target_deleted', 'warning', 'Ping Monitor', `Ping target "${target.name}" (${target.host}) removed from group "${target.group}"`, {
      targetId: target.id,
      targetName: target.name,
      targetHost: target.host,
      targetGroup: target.group
    });

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

    // Log the event
    const action = target.enabled ? 'enabled' : 'disabled';
    logEvent('ping_target_toggled', 'info', 'Ping Monitor', `Ping target "${target.name}" (${target.host}) ${action}`, {
      targetId: target.id,
      targetName: target.name,
      targetHost: target.host,
      targetGroup: target.group,
      enabled: target.enabled
    });

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

// API to get domain targets
app.get('/api/domain-targets', (req, res) => {
  res.json(domainTargets);
});

// API to add domain target
app.post('/api/domain-targets', (req, res) => {
  try {
    const { name, registrar, expiration_date, auto_renew, group } = req.body;

    if (!name || !expiration_date || !group) {
      return res.status(400).json({ error: 'Name, expiration date, and group are required' });
    }

    // Check if domain already exists
    const existingTarget = domainTargets.find(target => target.name === name);
    if (existingTarget) {
      return res.status(400).json({ error: 'Domain already exists' });
    }

    const newTarget = {
      id: Math.max(...domainTargets.map(t => t.id), 0) + 1,
      name,
      registrar: registrar || 'Unknown',
      expiration_date,
      auto_renew: auto_renew || false,
      group,
      enabled: true,
      last_checked: new Date().toISOString()
    };

    domainTargets.push(newTarget);
    fs.writeFileSync(domainTargetsFile, JSON.stringify(domainTargets, null, 2));

    res.json(newTarget);
  } catch (error) {
    console.error('Error adding domain target:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to delete domain target
app.delete('/api/domain-targets/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = domainTargets.findIndex(target => target.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Domain target not found' });
    }

    domainTargets.splice(index, 1);
    fs.writeFileSync(domainTargetsFile, JSON.stringify(domainTargets, null, 2));

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting domain target:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to toggle domain target
app.patch('/api/domain-targets/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const target = domainTargets.find(target => target.id === id);

    if (!target) {
      return res.status(404).json({ error: 'Domain target not found' });
    }

    target.enabled = !target.enabled;
    fs.writeFileSync(domainTargetsFile, JSON.stringify(domainTargets, null, 2));

    res.json(target);
  } catch (error) {
    console.error('Error toggling domain target:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to get domain history
app.get('/api/domain-history/:id', (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const target = domainTargets.find(t => t.id === targetId);

    if (!target) {
      return res.status(404).json({ error: 'Domain target not found' });
    }

    // For now, return mock history data
    // In a real implementation, this would query InfluxDB
    const history = [];
    const now = new Date();

    // Generate some sample history data
    for (let i = 30; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);

      const daysLeft = Math.ceil((new Date(target.expiration_date) - date) / (1000 * 60 * 60 * 24));

      history.push({
        time: date.toISOString(),
        days_left: Math.max(0, daysLeft),
        status: daysLeft > 30 ? 'active' : daysLeft > 0 ? 'expiring_soon' : 'expired'
      });
    }

    res.json({ data: history });
  } catch (error) {
    console.error('Error getting domain history:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to get website targets
app.get('/api/website-targets', (req, res) => {
  res.json(websiteTargets);
});

// API to add website target
app.post('/api/website-targets', (req, res) => {
  try {
    const { name, url, group } = req.body;

    if (!name || !url || !group) {
      return res.status(400).json({ error: 'Name, URL, and group are required' });
    }

    // Check if URL already exists
    const existingTarget = websiteTargets.find(target => target.url === url);
    if (existingTarget) {
      return res.status(400).json({ error: 'URL already exists' });
    }

    const newTarget = {
      id: Math.max(...websiteTargets.map(t => t.id), 0) + 1,
      name: name.trim(),
      url: url.trim(),
      group: group.trim(),
      enabled: true
    };

    websiteTargets.push(newTarget);
    saveWebsiteTargets();

    res.json({
      success: true,
      message: 'Website target added successfully',
      target: newTarget
    });
  } catch (err) {
    console.error('Error adding website target:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to delete website target
app.delete('/api/website-targets/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = websiteTargets.findIndex(target => target.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Website target not found' });
    }

    websiteTargets.splice(index, 1);
    saveWebsiteTargets();

    res.json({
      success: true,
      message: 'Website target deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting website target:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to toggle website target status
app.patch('/api/website-targets/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const target = websiteTargets.find(target => target.id === id);

    if (!target) {
      return res.status(404).json({ error: 'Website target not found' });
    }

    target.enabled = !target.enabled;
    saveWebsiteTargets();

    res.json({
      success: true,
      message: 'Website target status updated successfully',
      target: target
    });
  } catch (err) {
    console.error('Error toggling website target:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to perform website test
app.post('/api/website-test', async (req, res) => {
  const { targetId } = req.body;

  if (!targetId) {
    return res.status(400).json({ error: 'Target ID is required' });
  }

  const target = websiteTargets.find(t => t.id === parseInt(targetId));
  if (!target) {
    return res.status(404).json({ error: 'Target not found' });
  }

  try {
    const result = await checkWebsiteStatus(target);
    addWebsiteToDatabase(target.id, result);
    res.json({
      targetId: target.id,
      targetName: target.name,
      url: target.url,
      up: result.up,
      responseTime: result.responseTime,
      statusCode: result.statusCode,
      sslExpiry: result.sslExpiry,
      sslValid: result.sslValid,
      sslIssuer: result.sslIssuer
    });
  } catch (err) {
    console.error(`[WEBSITE API] Error testing website ${target.name}:`, err);
    res.status(500).json({ error: 'Website test failed' });
  }
});

// API to get website history
app.get('/api/website-history/:targetId', async (req, res) => {
  const { targetId } = req.params;

  try {
    const queryApi = client.getQueryApi(settings.influxdb.org);

    const fluxQuery = `
      from(bucket: "${settings.influxdb.bucket}")
      |> range(start: -30d)
      |> filter(fn: (r) => r._measurement == "website_metric")
      |> filter(fn: (r) => r.target_id == "${targetId}")
      |> filter(fn: (r) => r._field == "up" or r._field == "response_time" or r._field == "status_code" or r._field == "ssl_expiry" or r._field == "ssl_valid" or r._field == "ssl_issuer")
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
          up: null,
          responseTime: null,
          statusCode: null,
          sslExpiry: null,
          sslValid: null,
          sslIssuer: null
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
    console.error('[WEBSITE API] Error fetching website history:', err);
    res.status(500).json({ error: 'Failed to fetch website history' });
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

  // Use credentials from settings.json (configurable)
  const authConfig = settings.authentication || { enabled: true, username: 'admin', password: 'admin123' };
  const sessionTimeout = authConfig.sessionTimeout || (24 * 60 * 60 * 1000); // Default 24 hours

  if (authConfig.enabled && username === authConfig.username && password === authConfig.password) {
    // Set session or cookie for authentication
    res.cookie('authenticated', 'true', { maxAge: sessionTimeout });
    console.log(`[AUTH] User '${username}' logged in successfully`);
    res.redirect('/');
  } else {
    console.warn(`[AUTH] Failed login attempt with username: ${username}`);
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
        title: 'Bandwidth Monitoring',
        devices: {},
        selectedDevice: null,
        pollingIntervalSeconds: settings.pollingInterval / 1000,
        pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
      });
    }

    // If a specific device is requested but doesn't exist, redirect to monitoring without device
    if (deviceId && !snmpDevices[deviceId]) {
      return res.redirect('/monitoring');
    }

    res.render('monitoring', {
      title: 'Bandwidth Monitoring',
      devices: snmpDevices,
      selectedDevice: deviceId,
      pollingIntervalSeconds: settings.pollingInterval / 1000,
      pingIntervalSeconds: settings.pingInterval ? settings.pingInterval / 1000 : 30
    });
  } catch (err) {
    console.error('Route error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Bandwidth Dashboard Route
app.get('/bandwidth', (req, res) => {
  try {
    console.log('Route /bandwidth called');

    res.render('bandwidth', {
      title: 'Bandwidth Dashboard',
      devices: snmpDevices
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

// API to update website monitoring settings
app.post('/api/settings/website', (req, res) => {
  try {
    const { enabled, interval, timeout, notifyOnDown, notifyOnUp, notifyOnSslExpiry, sslExpiryWarningDays } = req.body;

    if (!settings.website) {
      settings.website = {};
    }

    settings.website.enabled = enabled !== undefined ? enabled : true;

    if (interval !== undefined) {
      if (interval < 30000) {
        return res.status(400).json({ error: 'Monitoring interval must be at least 30 seconds' });
      }
      settings.website.interval = interval;
    }

    if (timeout !== undefined) {
      if (timeout < 1000) {
        return res.status(400).json({ error: 'Request timeout must be at least 1 second' });
      }
      settings.website.timeout = timeout;
    }

    settings.website.notifyOnDown = notifyOnDown !== undefined ? notifyOnDown : true;
    settings.website.notifyOnUp = notifyOnUp !== undefined ? notifyOnUp : true;
    settings.website.notifyOnSslExpiry = notifyOnSslExpiry !== undefined ? notifyOnSslExpiry : true;

    if (sslExpiryWarningDays !== undefined) {
      if (sslExpiryWarningDays < 1 || sslExpiryWarningDays > 90) {
        return res.status(400).json({ error: 'SSL expiry warning must be between 1 and 90 days' });
      }
      settings.website.sslExpiryWarningDays = sslExpiryWarningDays;
    }

    saveSettings();

    res.json({
      success: true,
      website: settings.website
    });
  } catch (err) {
    console.error('Error updating website settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
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
    const interfaceMap = {}; // Map to store interfaces by index
    let responsesSent = false;
    let pendingIfNameQuery = false;

    const sendResponse = () => {
      if (!responsesSent) {
        responsesSent = true;
        try {
          tempSession.close();
        } catch (e) {
          // Ignore close errors
        }

        const filteredInterfaces = Object.values(interfaceMap)
          .sort((a, b) => a.index - b.index);

        console.log(`[DISCOVER] SNMP discovery completed, found ${filteredInterfaces.length} interfaces for ${vendor} device`);
        res.json({ interfaces: filteredInterfaces, vendor });
      }
    };

    const timeout = setTimeout(() => {
      console.log(`[DISCOVER] SNMP discovery timeout after 10 seconds, found ${Object.keys(interfaceMap).length} interfaces for ${vendor} device`);
      sendResponse();
    }, 10000); // 10 second timeout for discovery

    // First, get system description to detect vendor
    tempSession.get(['1.3.6.1.2.1.1.1.0'], function (error, varbinds) {
      if (!error && varbinds && varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
        const sysDescr = varbinds[0].value.toString();
        vendor = detectVendor(sysDescr);
        console.log(`[DISCOVER] Detected vendor: ${vendor} for device ${host}`);
      } else {
        console.log(`[DISCOVER] Could not detect vendor for ${host}, using standard MIB-II`);
      }

      // Now proceed with interface discovery
      const ifDescrOid = getVendorOID(vendor, 'ifDescr');
      console.log(`[DISCOVER] Using OID ${ifDescrOid} for interface discovery`);

      tempSession.walk(ifDescrOid, 30, function (varbinds) {
        varbinds.forEach(vb => {
          if (snmp.isVarbindError(vb)) {
            // Skip errors
          } else {
            const oidParts = vb.oid.split('.');
            const index = oidParts[oidParts.length - 1];
            const name = vb.value.toString().trim();

            if (!interfaceMap[index]) {
              interfaceMap[index] = {
                index: parseInt(index),
                name: name,
                hasName: name.length > 0
              };
            }
          }
        });
      }, function (error) {
        if (error && !error.toString().includes('Socket forcibly closed')) {
          console.log(`[DISCOVER] SNMP walk error: ${error}`);
        }

        // After ifDescr walk completes, check for interfaces with empty names
        const emptyNameIndices = Object.keys(interfaceMap)
          .filter(idx => !interfaceMap[idx].hasName)
          .map(idx => parseInt(idx));

        console.log(`[DISCOVER] Found ${Object.keys(interfaceMap).length} interfaces, ${emptyNameIndices.length} with empty names`);

        if (emptyNameIndices.length > 0 && emptyNameIndices.length <= 100) {
          // Try to get ifName for interfaces with empty descriptions
          const ifNameOids = emptyNameIndices.map(idx => `1.3.6.1.2.1.31.1.1.1.1.${idx}`);

          pendingIfNameQuery = true;
          console.log(`[DISCOVER] Attempting to get ifName for ${emptyNameIndices.length} interfaces with empty descriptions`);

          tempSession.get(ifNameOids, function (error, varbinds) {
            if (!error && varbinds) {
              varbinds.forEach((vb, idx) => {
                if (!snmp.isVarbindError(vb) && vb.value) {
                  const ifName = vb.value.toString().trim();
                  if (ifName.length > 0) {
                    const index = emptyNameIndices[idx];
                    console.log(`[DISCOVER] Found ifName for interface ${index}: ${ifName}`);
                    interfaceMap[index].name = ifName;
                    interfaceMap[index].hasName = true;
                  }
                }
              });
            } else if (error && !error.toString().includes('Socket forcibly closed')) {
              console.log(`[DISCOVER] ifName fallback error: ${error}`);
            }

            pendingIfNameQuery = false;
            clearTimeout(timeout);
            sendResponse();
          });
        } else {
          // No empty names or too many to query, send response immediately
          clearTimeout(timeout);
          sendResponse();
        }
      });
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

// API to get weathermap link data
app.get('/api/weathermap/links', async (req, res) => {
  try {
    const devices = [];
    const links = [];

    // Iterate through all SNMP devices
    for (const [deviceId, device] of Object.entries(snmpDevices)) {
      // Add device to devices array
      devices.push({
        id: deviceId,
        name: device.name,
        status: deviceStatusHistory[deviceId]?.alive ? 'up' : 'down',
        host: device.host,
        vendor: device.vendor || 'unknown',
        type: 'device',
        hasSnmpData: device.selectedInterfaces && device.selectedInterfaces.length > 0
      });

      // Get interfaces for this device
      if (device.selectedInterfaces && device.selectedInterfaces.length > 0) {
        for (const iface of device.selectedInterfaces) {
          if (typeof iface === 'object' && iface.index && iface.name) {
            try {
              // Query InfluxDB for bandwidth data for this interface
              const bandwidthData = await getCurrentBandwidth(deviceId, iface.name);

              if (bandwidthData && bandwidthData.rxMbps !== null && bandwidthData.txMbps !== null) {
                // Calculate load based on speed
                const totalMbps = (bandwidthData.rxMbps + bandwidthData.txMbps);
                let load = 0;

                if (bandwidthData.speed && bandwidthData.speed > 0) {
                  // Speed is in bps, convert to Mbps for calculation
                  const speedMbps = bandwidthData.speed / 1000000;
                  load = Math.min(100, (totalMbps / speedMbps) * 100);
                } else {
                  // If no speed data, estimate based on interface type
                  let estimatedSpeedMbps = 1000; // Default 1Gbps

                  const interfaceName = iface.name.toLowerCase();
                  if (interfaceName.includes('sfp') || interfaceName.includes('10g')) {
                    estimatedSpeedMbps = 10000; // 10Gbps for SFP/SFP+ interfaces
                  } else if (interfaceName.includes('ether') && !interfaceName.includes('10')) {
                    estimatedSpeedMbps = 1000; // 1Gbps for Ethernet
                  } else if (interfaceName.includes('vlan') || interfaceName.includes('bridge')) {
                    estimatedSpeedMbps = 1000; // 1Gbps for VLAN/Bridge
                  }

                  load = Math.min(100, (totalMbps / estimatedSpeedMbps) * 100);
                }

                // Create a link for this interface (self-link to show load)
                links.push({
                  id: `${deviceId}_${iface.index}`,
                  sourceDevice: deviceId,
                  targetDevice: deviceId,
                  load: Math.max(0, Math.min(100, load)),
                  speed: bandwidthData.speed || null,
                  interface: iface.name,
                  direction: 'bidirectional',
                  description: `${iface.name} (${bandwidthData.rxMbps.toFixed(1)}/${bandwidthData.txMbps.toFixed(1)} Mbps, ${load.toFixed(2)}%)`
                });
              }
            } catch (error) {
              console.error(`[WEATHERMAP] Error getting bandwidth for ${deviceId}:${iface.name}:`, error);
            }
          }
        }
      }
    }

    console.log(`[WEATHERMAP] Returning ${devices.length} devices and ${links.length} links`);

    res.json({
      devices: devices,
      links: links
    });
  } catch (err) {
    console.error('Error fetching weathermap data:', err);
    res.status(500).json({ error: 'Failed to fetch weathermap data' });
  }
});

// API to get bandwidth data for specific interface
app.get('/api/devices/:deviceId/interfaces/:interfaceName/bandwidth', async (req, res) => {
  try {
    const { deviceId, interfaceName } = req.params;

    if (!snmpDevices[deviceId]) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const bandwidthData = await getCurrentBandwidth(deviceId, interfaceName);

    if (!bandwidthData) {
      return res.json({ rxMbps: 0, txMbps: 0 });
    }

    res.json({
      rxMbps: bandwidthData.rxMbps || 0,
      txMbps: bandwidthData.txMbps || 0,
      speed: bandwidthData.speed || null
    });
  } catch (error) {
    console.error(`[BANDWIDTH] Error getting bandwidth for ${deviceId}:${interfaceName}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to get interface speed via SNMP
async function getInterfaceSpeed(deviceId, interfaceIndex) {
  return new Promise((resolve, reject) => {
    const session = snmpSessions[deviceId];
    if (!session) {
      resolve(null);
      return;
    }

    // OID for interface speed (IF-MIB::ifSpeed)
    const oid = `1.3.6.1.2.1.2.2.1.5.${interfaceIndex}`;

    session.get([oid], (error, varbinds) => {
      if (error) {
        console.warn(`SNMP error getting speed for ${deviceId}:${interfaceIndex}:`, error.message);
        resolve(null);
        return;
      }

      if (varbinds && varbinds[0] && varbinds[0].value !== undefined) {
        const speed = varbinds[0].value;
        // ifSpeed is in bits per second, return as is
        resolve(speed);
      } else {
        resolve(null);
      }
    });
  });
}

// Helper function to get current bandwidth for an interface
async function getCurrentBandwidth(deviceId, interfaceName) {
  try {
    const queryApi = client.getQueryApi(settings.influxdb.org);

    // Query last 10 minutes of data to calculate rate
    const fluxQuery = `
      from(bucket: "${settings.influxdb.bucket}")
        |> range(start: -10m)
        |> filter(fn: (r) => r["_measurement"] == "snmp_metric")
        |> filter(fn: (r) => r["device"] == "${deviceId}")
        |> filter(fn: (r) => r["interface"] == "${interfaceName}")
        |> filter(fn: (r) => r["_field"] == "value")
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: 20)
    `;

    const result = await queryApi.collectRows(fluxQuery);

    if (result.length === 0) return null;

    // Group data by direction
    const rxData = result.filter(row => row.direction === 'rx').slice(0, 5); // Last 5 RX points
    const txData = result.filter(row => row.direction === 'tx').slice(0, 5); // Last 5 TX points

    // Reverse to get oldest first for proper diff calculation
    rxData.reverse();
    txData.reverse();

    // Calculate average rate for RX
    let rxMbps = 0;
    if (rxData.length >= 2) {
      const timeDiff = (new Date(rxData[rxData.length - 1]._time).getTime() - new Date(rxData[0]._time).getTime()) / 1000 / 60; // minutes
      const maxCounterValue = 4294967295; // 2^32 - 1 for 32-bit counters
      const totalOctets = rxData.slice(0, -1).reduce((sum, point, index) => {
        let diff = rxData[index + 1]._value - point._value;
        // Handle counter rollover
        if (diff < 0) {
          diff += maxCounterValue + 1;
        }
        return sum + diff;
      }, 0);
      const avgOctetsPerSecond = totalOctets / (timeDiff * 60);
      rxMbps = (avgOctetsPerSecond * 8) / 1000000; // Convert to Mbps
    }

    // Calculate average rate for TX
    let txMbps = 0;
    if (txData.length >= 2) {
      const timeDiff = (new Date(txData[txData.length - 1]._time).getTime() - new Date(txData[0]._time).getTime()) / 1000 / 60; // minutes
      const maxCounterValue = 4294967295; // 2^32 - 1 for 32-bit counters (many interfaces use 32-bit)
      const totalOctets = txData.slice(0, -1).reduce((sum, point, index) => {
        let diff = txData[index + 1]._value - point._value;
        // Handle counter rollover
        if (diff < 0) {
          diff += maxCounterValue + 1;
        }
        return sum + diff;
      }, 0);
      const avgOctetsPerSecond = totalOctets / (timeDiff * 60);
      txMbps = (avgOctetsPerSecond * 8) / 1000000; // Convert to Mbps
    }

    // Get interface speed (if available)
    let speed = null;
    try {
      // Try to get speed from SNMP first
      const device = snmpDevices[deviceId];
      if (device && device.selectedInterfaces) {
        const iface = device.selectedInterfaces.find(i => i.name === interfaceName);
        if (iface && iface.index) {
          speed = await getInterfaceSpeed(deviceId, iface.index);
        }
      }

      // Fallback to config if SNMP fails
      if (!speed && device && device.selectedInterfaces) {
        const iface = device.selectedInterfaces.find(i => i.name === interfaceName);
        if (iface && iface.speed) {
          speed = iface.speed;
        }
      }
    } catch (error) {
      console.warn(`Could not get speed for ${deviceId}:${interfaceName}:`, error.message);
    }

    return {
      rxMbps: rxMbps,
      txMbps: txMbps,
      speed: speed
    };
  } catch (error) {
    console.error('Error querying bandwidth data:', error);
    return null;
  }
}

// Placeholder function to find connected device (would need topology database)
function findConnectedDevice(sourceDeviceId, interfaceName) {
  // This is a placeholder - in reality you'd have a topology database
  // or use LLDP/CDP information to determine connections

  // For demo purposes, return null (no connections)
  // In a real implementation, you might:
  // 1. Query LLDP neighbors from SNMP
  // 2. Use a topology database
  // 3. Use interface naming conventions

  return null;
}

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
      // Bandwidth data - convert stored deltas to Mbps using actual polling interval
      const pollingIntervalSeconds = settings.pollingInterval / 1000;
      if (interface !== 'all') {
        query += ` |> filter(fn: (r) => r.interface == "${interface}")`;
      }
      if (direction !== 'all') {
        query += ` |> filter(fn: (r) => r.direction == "${direction}")`;
      }
      query += `
        |> map(fn: (r) => ({ r with _value: r._value * 8.0 / 1000000.0 / ${pollingIntervalSeconds}.0 }))
        |> filter(fn: (r) => r._value >= 0)
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

        // Get appropriate OIDs for this vendor - try 64-bit counters first for high-speed interfaces
        // Use getVendorOID to handle vendor-specific mappings (including Mikrotik)
        const rxOid64 = `${getVendorOID(vendor, 'ifHCInOctets')}.${iface.index}`;
        const txOid64 = `${getVendorOID(vendor, 'ifHCOutOctets')}.${iface.index}`;

        // Fallback to vendor-specific or standard 32-bit counters
        const rxOid32 = `${getVendorOID(vendor, 'ifInOctets')}.${iface.index}`;
        const txOid32 = `${getVendorOID(vendor, 'ifOutOctets')}.${iface.index}`;

        console.log(`[${deviceId}] Trying 64-bit counters first - RX: ${rxOid64}, TX: ${txOid64}`);

        // Query RX traffic - try 64-bit first, then 32-bit
        snmpSessions[deviceId].get([rxOid64], function (rxError64, rxVarbinds64) {
          let rxValue = null;
          let use64bit = false;

          if (rxError64) {
            console.log(`[${deviceId}] 64-bit RX error for ${iface.name}, falling back to 32-bit: ${rxError64.message}`);
          } else if (!rxVarbinds64 || snmp.isVarbindError(rxVarbinds64[0])) {
            console.log(`[${deviceId}] 64-bit RX varbind error for ${iface.name}, falling back to 32-bit`);
          } else {
            // Try to convert 64-bit value - it might be a BigInt, string, number, or Uint8Array
            let val = rxVarbinds64[0].value;

            // Debug: Log raw value info
            if (iface.name === 'sfp-sfpplus14') {
              console.log(`[${deviceId}] DEBUG sfp-sfpplus14 RX 64-bit value: type=${typeof val}, value=${val}, toString=${Object.prototype.toString.call(val)}`);
            }

            // Handle Uint8Array (binary buffer from SNMP)
            if (val instanceof Uint8Array || (typeof val === 'object' && val.buffer instanceof ArrayBuffer)) {
              // Convert Uint8Array to number
              let num = 0n; // Use BigInt for 64-bit
              const bytes = new Uint8Array(val);
              for (let i = 0; i < bytes.length; i++) {
                num = (num << 8n) | BigInt(bytes[i]);
              }
              rxValue = Number(num);
              use64bit = true;
              if (iface.name === 'sfp-sfpplus14') {
                console.log(`[${deviceId}] DEBUG Converted Uint8Array RX to: ${rxValue}`);
              }
            }
            // Check if it's a valid number or can be converted to number
            else if (typeof val === 'bigint') {
              rxValue = Number(val);
              use64bit = true;
            } else if (typeof val === 'string') {
              // Try parsing string to number
              const parsed = parseInt(val, 10);
              if (!isNaN(parsed)) {
                rxValue = parsed;
                use64bit = true;
              }
            } else if (typeof val === 'number' && !isNaN(val)) {
              rxValue = val;
              use64bit = true;
            }

            if (!use64bit) {
              console.log(`[${deviceId}] Failed to parse 64-bit RX counter for ${iface.name}: Parsed value is invalid: ${typeof rxVarbinds64[0].value} = ${rxVarbinds64[0].value}`);
              // Log specific warning for PPoE interfaces failing 64-bit check
              if (iface.name.toLowerCase().includes('pppoe') || iface.name.toLowerCase().includes('ppoe')) {
                console.warn(`[${deviceId}] [MIKROTIK-DEBUG] PPPoE interface ${iface.name} failed 64-bit OID check. OID used: ${rxOid64}. Falling back to 32-bit. This may cause graphing issues on high-speed links.`);
              }
            }
          }

          // If 64-bit didn't work, try 32-bit
          if (!use64bit) {
            snmpSessions[deviceId].get([rxOid32], function (rxError32, rxVarbinds32) {
              if (rxError32) {
                console.error(`[${deviceId}] SNMP RX error for interface ${iface.name}:`, rxError32.message);
              } else if (!rxVarbinds32 || snmp.isVarbindError(rxVarbinds32[0])) {
                console.error(`[${deviceId}] SNMP RX varbind error for ${iface.name}:`, rxVarbinds32 ? snmp.varbindError(rxVarbinds32[0]) : 'No varbinds');
              } else {
                let val = rxVarbinds32[0].value;
                let rxVal = val;

                // Try to convert if needed
                if (typeof val === 'bigint') {
                  rxVal = Number(val);
                } else if (typeof val === 'string') {
                  const parsed = parseInt(val, 10);
                  if (!isNaN(parsed)) rxVal = parsed;
                }

                if (typeof rxVal === 'number' && !isNaN(rxVal)) {
                  console.log(`[${deviceId}] Using 32-bit RX counter for ${iface.name}: ${rxVal}`);
                  processRxData(deviceId, device, iface, rxVal, pollTimestamp);
                } else {
                  console.error(`[${deviceId}] SNMP RX invalid value for ${iface.name}:`, rxVal);
                }
              }
            });
          } else {
            console.log(`[${deviceId}] Using 64-bit RX counter for ${iface.name}: ${rxValue}`);
            processRxData(deviceId, device, iface, rxValue, pollTimestamp);
          }
        });

        // Query TX traffic - try 64-bit first, then 32-bit
        snmpSessions[deviceId].get([txOid64], function (txError64, txVarbinds64) {
          let txValue = null;
          let use64bit = false;

          if (txError64) {
            console.log(`[${deviceId}] 64-bit TX error for ${iface.name}, falling back to 32-bit: ${txError64.message}`);
          } else if (!txVarbinds64 || snmp.isVarbindError(txVarbinds64[0])) {
            console.log(`[${deviceId}] 64-bit TX varbind error for ${iface.name}, falling back to 32-bit`);
          } else {
            // Try to convert 64-bit value - it might be a BigInt, string, or number
            let val = txVarbinds64[0].value;

            // Debug: Log raw value info
            if (iface.name === 'sfp-sfpplus14') {
              console.log(`[${deviceId}] DEBUG sfp-sfpplus14 TX 64-bit value: type=${typeof val}, value=${val}, toString=${Object.prototype.toString.call(val)}`);
            }

            // Check if it's a valid number or can be converted to number
            // Handle Uint8Array (binary buffer from SNMP)
            if (val instanceof Uint8Array || (typeof val === 'object' && val.buffer instanceof ArrayBuffer)) {
              // Convert Uint8Array to number
              let num = 0n; // Use BigInt for 64-bit
              const bytes = new Uint8Array(val);
              for (let i = 0; i < bytes.length; i++) {
                num = (num << 8n) | BigInt(bytes[i]);
              }
              txValue = Number(num);
              use64bit = true;
              if (iface.name === 'sfp-sfpplus14') {
                console.log(`[${deviceId}] DEBUG Converted Uint8Array TX to: ${txValue}`);
              }
            }
            // Check if it's a valid number or can be converted to number
            else if (typeof val === 'bigint') {
              txValue = Number(val);
              use64bit = true;
            } else if (typeof val === 'string') {
              // Try parsing string to number
              const parsed = parseInt(val, 10);
              if (!isNaN(parsed)) {
                txValue = parsed;
                use64bit = true;
              }
            } else if (typeof val === 'number' && !isNaN(val)) {
              txValue = val;
              use64bit = true;
            }

            if (!use64bit) {
              console.log(`[${deviceId}] Failed to parse 64-bit TX counter for ${iface.name}: Parsed value is invalid: ${typeof txVarbinds64[0].value} = ${txVarbinds64[0].value}`);
            }
          }

          // If 64-bit didn't work, try 32-bit
          if (!use64bit) {
            snmpSessions[deviceId].get([txOid32], function (txError32, txVarbinds32) {
              if (txError32) {
                console.error(`[${deviceId}] SNMP TX error for interface ${iface.name}:`, txError32.message);
              } else if (!txVarbinds32 || snmp.isVarbindError(txVarbinds32[0])) {
                console.error(`[${deviceId}] SNMP TX varbind error for ${iface.name}:`, txVarbinds32 ? snmp.varbindError(txVarbinds32[0]) : 'No varbinds');
              } else {
                let val = txVarbinds32[0].value;
                let txVal = val;

                // Try to convert if needed
                if (typeof val === 'bigint') {
                  txVal = Number(val);
                } else if (typeof val === 'string') {
                  const parsed = parseInt(val, 10);
                  if (!isNaN(parsed)) txVal = parsed;
                }

                if (typeof txVal === 'number' && !isNaN(txVal)) {
                  console.log(`[${deviceId}] Using 32-bit TX counter for ${iface.name}: ${txVal}`);
                  processTxData(deviceId, device, iface, txVal, pollTimestamp);
                } else {
                  console.error(`[${deviceId}] SNMP TX invalid value for ${iface.name}:`, txVal);
                }
              }
            });
          } else {
            console.log(`[${deviceId}] Using 64-bit TX counter for ${iface.name}: ${txValue}`);
            processTxData(deviceId, device, iface, txValue, pollTimestamp);
          }
        });
      });

      // Poll CPU usage for this device - but only if CPU has been successfully detected before
      // or if we haven't tried recently
      const vendor = device.vendor || 'standard';
      const cpuOid = getCpuOID(vendor);

      // Initialize device CPU status if not exists
      if (!deviceCpuStatus[deviceId]) {
        deviceCpuStatus[deviceId] = { hasCpu: null, lastAttempt: 0, failureCount: 0 };
      }

      const cpuStatus = deviceCpuStatus[deviceId];
      const now = Date.now();
      const oneHourAgo = 60 * 60 * 1000; // 1 hour in milliseconds

      // Skip CPU polling if:
      // 1. hasCpu is explicitly false (CPU not detected)
      // 2. We've had more than 5 consecutive failures (likely no CPU support)
      if (cpuStatus.hasCpu === false || cpuStatus.failureCount >= 5) {
        if (cpuStatus.failureCount >= 5) {
          // Re-check every hour to see if CPU is now available (in case of device restart)
          if (now - cpuStatus.lastAttempt > oneHourAgo) {
            console.log(`[${deviceId}] Retrying CPU polling after 1 hour (${cpuStatus.failureCount} failures)`);
            cpuStatus.failureCount = 0; // Reset counter for re-attempt
          } else {
            // Still within cooldown period, skip CPU polling
            return; // Skip rest of polling for this device (no return here, just skip CPU)
          }
        } else {
          return; // Skip CPU polling
        }
      }

      if (cpuOid) {
        console.log(`[${deviceId}] Polling CPU using ${vendor} OID: ${cpuOid}`);

        snmpSessions[deviceId].get([cpuOid], function (cpuError, cpuVarbinds) {
          if (cpuError) {
            // CPU query failed
            cpuStatus.failureCount++;
            console.warn(`[${deviceId}] SNMP CPU error (attempt ${cpuStatus.failureCount}): ${cpuError.message}`);

            // Try fallback to standard UCD-SNMP-MIB if vendor-specific OID fails
            if (vendor !== 'standard' && cpuStatus.failureCount <= 2) {
              const fallbackCpuOid = '1.3.6.1.4.1.2021.11.9.0'; // UCD-SNMP-MIB CPU usage
              snmpSessions[deviceId].get([fallbackCpuOid], function (fallbackError, fallbackVarbinds) {
                if (!fallbackError && fallbackVarbinds && !snmp.isVarbindError(fallbackVarbinds[0])) {
                  console.log(`[${deviceId}] CPU fallback successful`);
                  cpuStatus.hasCpu = true;
                  cpuStatus.failureCount = 0;
                  cpuStatus.lastAttempt = now;

                  let cpuValue = parseFloat(fallbackVarbinds[0].value);

                  // Mikrotik CPU values are often multiplied by 100, so divide by 100 for percentage
                  if (vendor === 'mikrotik' && cpuValue > 100) {
                    cpuValue = cpuValue / 100;
                  }

                  if (!isNaN(cpuValue) && cpuValue >= 0 && cpuValue <= 100) {
                    processCpuData(deviceId, device, cpuValue, pollTimestamp);
                  }
                } else {
                  // Fallback also failed, mark as no CPU
                  cpuStatus.failureCount++;
                  if (cpuStatus.failureCount >= 5) {
                    cpuStatus.hasCpu = false;
                    console.warn(`[${deviceId}] CPU SNMP not supported - disabling CPU polling`);
                  }
                }
                cpuStatus.lastAttempt = now;
              });
            } else {
              // No fallback or too many failures
              if (cpuStatus.failureCount >= 5) {
                cpuStatus.hasCpu = false;
                console.warn(`[${deviceId}] CPU SNMP not supported - disabling CPU polling`);
              }
              cpuStatus.lastAttempt = now;
            }
          } else if (snmp.isVarbindError(cpuVarbinds[0])) {
            console.error(`[${deviceId}] SNMP CPU varbind error:`, snmp.varbindError(cpuVarbinds[0]));
            cpuStatus.failureCount++;
            if (cpuStatus.failureCount >= 5) {
              cpuStatus.hasCpu = false;
              console.warn(`[${deviceId}] CPU SNMP not supported - disabling CPU polling`);
            }
            cpuStatus.lastAttempt = now;
          } else {
            // CPU query successful
            cpuStatus.hasCpu = true;
            cpuStatus.failureCount = 0;
            cpuStatus.lastAttempt = now;

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
        cpuStatus.hasCpu = false;
        cpuStatus.failureCount = 5; // Mark as disabled to skip future polling
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

// Data retention cleanup function - DISABLED due to InfluxDB client API issues
function cleanupOldData() {
  console.log('[DATA RETENTION] Cleanup called at', new Date().toISOString());
  console.log('[DATA RETENTION] Cleanup disabled - InfluxDB delete API not available in current client version');

  // TODO: Implement proper data retention using InfluxDB v2 API or task
  // For now, rely on InfluxDB's built-in retention policies
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
    setInterval(cleanupCounterHistory, 6 * 60 * 60 * 1000); // Every 6 hours
  }, timeUntilCleanup);

  console.log(`[DATA RETENTION] Daily cleanup scheduled for ${scheduledTime.toLocaleTimeString()}`);
}

// Polling interval management
let pollInterval;

// Duplicate startPolling/restartPolling removed


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

// System stats API endpoint for dashboard header
app.get('/api/system/stats', (req, res) => {
  const os = require('os');

  // Get CPU usage
  const cpus = os.cpus();
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

  // Get memory info
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryPercent = Math.round((usedMemory / totalMemory) * 100);
  const memoryGB = (usedMemory / (1024 * 1024 * 1024)).toFixed(1) + 'GB';

  // Get disk info
  let diskUsage = 'N/A';
  try {
    const { execSync } = require('child_process');
    const dfOutput = execSync('df -h / | tail -1').toString();
    const parts = dfOutput.split(/\s+/);
    if (parts.length >= 5) {
      // Show used/total instead of just percentage
      diskUsage = parts[2] + '/' + parts[1]; // Used/Size
    }
  } catch (err) {
    console.error('Error getting disk info:', err);
  }

  res.json({
    cpu: Math.max(0, Math.min(100, cpuUsage)),
    memory: memoryGB, // Remove percentage
    disk: diskUsage
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

// Start website monitoring (run immediately, then on interval)
if (settings.website && settings.website.enabled) {
  startWebsiteMonitoring(); // Run immediately
  setInterval(startWebsiteMonitoring, settings.website.interval);
}

// Website monitoring function
async function startWebsiteMonitoring() {
  console.log('[WEBSITE] Starting website monitoring for', websiteTargets.length, 'targets');

  for (const target of websiteTargets) {
    if (!target.enabled) continue;

    try {
      const result = await checkWebsiteStatus(target);
      // Check for status changes and send notifications
      const previousStatus = websiteStatusHistory[target.id];
      const isUp = result.up;
      const responseTime = result.responseTime;
      const sslExpiry = result.sslExpiry;
      const sslValid = result.sslValid;
      const sslIssuer = result.sslIssuer;

      // Initialize status history if not exists
      if (!websiteStatusHistory[target.id]) {
        websiteStatusHistory[target.id] = {
          up: isUp,
          lastResponseTime: responseTime,
          lastSslExpiry: sslExpiry,
          lastSslValid: sslValid,
          lastSslIssuer: sslIssuer,
          lastCheck: Date.now()
        };
      }

      // Check for status changes
      if (previousStatus) {
        // Website went from down to up
        if (!previousStatus.up && isUp) {
          notifyWebsiteStatus(target.id, target.name, target.url, 'up', responseTime);
        }
        // Website went from up to down
        else if (previousStatus.up && !isUp) {
          notifyWebsiteStatus(target.id, target.name, target.url, 'down', responseTime);
        }
      }

      // Check SSL expiry warnings
      if (isUp && sslExpiry && settings.website.notifyOnSslExpiry) {
        const daysUntilExpiry = Math.ceil((sslExpiry - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysUntilExpiry <= settings.website.sslExpiryWarningDays) {
          notifyWebsiteStatus(target.id, target.name, target.url, 'ssl_expiry_warning', responseTime, daysUntilExpiry);
        }
      }

      // Update status history
      websiteStatusHistory[target.id] = {
        up: isUp,
        lastResponseTime: responseTime,
        lastSslExpiry: sslExpiry,
        lastSslValid: sslValid,
        lastSslIssuer: sslIssuer,
        lastCheck: Date.now()
      };

      addWebsiteToDatabase(target.id, result);
    } catch (err) {
      console.error(`[WEBSITE] Error checking ${target.name} (${target.url}):`, err);

      // Check for status changes on error
      const previousStatus = websiteStatusHistory[target.id];
      if (previousStatus && previousStatus.up) {
        // Website was up but now has error (treat as down)
        notifyWebsiteStatus(target.id, target.name, target.url, 'down', 0);
      }

      // Update status history for failed check
      websiteStatusHistory[target.id] = {
        up: false,
        lastResponseTime: 0,
        lastSslExpiry: null,
        lastSslValid: false,
        lastSslIssuer: null,
        lastCheck: Date.now()
      };

      // Still record the failed check
      addWebsiteToDatabase(target.id, {
        up: false,
        responseTime: 0,
        sslExpiry: null,
        sslValid: false,
        sslIssuer: null,
        error: err.message
      });
    }
  }

  // Schedule next check
  if (settings.website.enabled) {
    setTimeout(startWebsiteMonitoring, settings.website.interval * 1000);
  }
}

// Function to check website status and SSL certificate
async function checkWebsiteStatus(target) {
  const url = new URL(target.url);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: settings.website.timeout || 10000,
      rejectUnauthorized: false // Allow self-signed certificates for checking
    };

    const req = (url.protocol === 'https:' ? https : http).request(options, async (res) => {
      const responseTime = Date.now() - startTime;
      let sslExpiry = null;
      let sslValid = false;
      let sslIssuer = null;

      // Check SSL certificate if HTTPS
      if (url.protocol === 'https:') {
        try {
          const cert = await getSSLCertificate(url.hostname, url.port || 443);

          if (cert && cert.valid_to) {
            sslExpiry = new Date(cert.valid_to).getTime();
            sslValid = Date.now() < sslExpiry;

            // Extract issuer information
            if (cert.issuer) {
              // Try different possible issuer fields
              sslIssuer = cert.issuer.CN || cert.issuer.O || cert.issuer.organizationName;
              if (!sslIssuer && cert.issuer.subject) {
                // Some certificates have issuer as a subject-like object
                sslIssuer = cert.issuer.subject.CN || cert.issuer.subject.O || cert.issuer.subject.organizationName;
              }
              if (!sslIssuer && typeof cert.issuer === 'string') {
                // Fallback: issuer might be a string
                sslIssuer = cert.issuer;
              }
            }

            // Debug logging (reduced)
            console.log(`[WEBSITE SSL] ${target.url} - Valid: ${sslValid}, Expiry: ${sslExpiry ? new Date(sslExpiry).toISOString() : 'null'}, Issuer: ${sslIssuer}`);
          } else {
            console.log(`[WEBSITE SSL] No valid certificate found for ${target.url}`);
          }
        } catch (sslErr) {
          console.warn(`[WEBSITE] SSL check failed for ${target.url}:`, sslErr.message);
        }
      }

      resolve({
        up: res.statusCode >= 200 && res.statusCode < 400,
        responseTime: responseTime,
        statusCode: res.statusCode,
        sslExpiry: sslExpiry,
        sslValid: sslValid,
        sslIssuer: sslIssuer
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Function to add website result to database
function addWebsiteToDatabase(targetId, result) {
  try {
    const writeApi = client.getWriteApi(settings.influxdb.org, settings.influxdb.bucket);
    const websitePoint = new Point('website_metric')
      .tag('target_id', targetId.toString())
      .tag('target_name', websiteTargets.find(t => t.id === targetId)?.name || 'unknown')
      .tag('target_url', websiteTargets.find(t => t.id === targetId)?.url || 'unknown')
      .timestamp(new Date())
      .booleanField('up', result.up)
      .floatField('response_time', result.responseTime || 0);

    if (result.statusCode) {
      websitePoint.intField('status_code', result.statusCode);
    }

    if (result.sslExpiry) {
      websitePoint.intField('ssl_expiry', result.sslExpiry);
    }

    if (result.sslValid !== undefined) {
      websitePoint.booleanField('ssl_valid', result.sslValid);
    }

    if (result.sslIssuer) {
      websitePoint.stringField('ssl_issuer', result.sslIssuer);
    }

    writeApi.writePoint(websitePoint);
    writeApi.close().then(() => {
      console.log(`[WEBSITE] Data written for ${websiteTargets.find(t => t.id === targetId)?.name}`);
    }).catch(err => {
      console.error('InfluxDB website write error:', err);
    });
  } catch (err) {
    console.error('Error creating website write API:', err);
  }
}

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
notifyDeviceStatus = function (deviceId, deviceName, status, details = '') {
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
notifyHighCpu = function (deviceId, deviceName, cpuValue) {
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
notifyPingStatus = function (targetId, targetName, targetHost, status, latency = null, packetLoss = null) {
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

// ============================================
// TOPOLOGY MAP API ENDPOINTS
// ============================================

// GET topology structure with real-time status
app.get('/api/topology', (req, res) => {
  try {
    const status = getTopologyStatus();
    res.json({
      nodes: topology.nodes,
      links: topology.links,
      views: topology.views,
      status: status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error fetching topology:', err);
    res.status(500).json({ error: 'Failed to fetch topology' });
  }
});

// DEBUG: Get ping status history
app.get('/api/debug/ping-status', (req, res) => {
  try {
    // Group ping targets by group (same as dashboard)
    const groupedPingTargets = {};
    pingTargets.forEach(target => {
      if (!groupedPingTargets[target.group]) {
        groupedPingTargets[target.group] = [];
      }
      groupedPingTargets[target.group].push(target);
    });

    // Create details array in the same order as displayed on dashboard
    const details = [];
    Object.entries(groupedPingTargets).forEach(([group, targets]) => {
      targets.forEach(target => {
        const history = pingStatusHistory[target.id];
        if (history) {
          details.push({
            latency: history.lastLatency || 0,
            loss: history.lastPacketLoss || 0,
            status: history.alive ? 'online' : 'offline'
          });
        } else {
          details.push({
            latency: 0,
            loss: 0,
            status: 'unknown'
          });
        }
      });
    });

    const debugInfo = {
      details: details,
      pingTargets: pingTargets.map(t => ({
        id: t.id,
        name: t.name,
        host: t.host,
        group: t.group,
        enabled: t.enabled,
        sourceNodeId: t.sourceNodeId,
        hasHistory: !!pingStatusHistory[t.id],
        history: pingStatusHistory[t.id]
      })),
      topologyNodes: topology.nodes.map(n => ({
        id: n.id,
        label: n.label,
        probeType: n.probeType,
        probeTarget: n.probeTarget,
        type: n.type
      }))
    };
    res.json(debugInfo);
  } catch (err) {
    console.error('Error fetching debug info:', err);
    res.status(500).json({ error: 'Failed to fetch debug info' });
  }
});

// GET topology nodes
app.get('/api/topology/nodes', (req, res) => {
  try {
    const status = getTopologyStatus();
    res.json({
      nodes: topology.nodes,
      nodeStatus: status.nodes
    });
  } catch (err) {
    console.error('Error fetching topology nodes:', err);
    res.status(500).json({ error: 'Failed to fetch topology nodes' });
  }
});

// GET topology links
app.get('/api/topology/links', (req, res) => {
  try {
    const status = getTopologyStatus();
    res.json({
      links: topology.links,
      linkStatus: status.links
    });
  } catch (err) {
    console.error('Error fetching topology links:', err);
    res.status(500).json({ error: 'Failed to fetch topology links' });
  }
});

// POST create new topology node
app.post('/api/topology/nodes', (req, res) => {
  try {
    const { id, label, ip, type, x, y, probeType, probeTarget, icon } = req.body;

    if (!id || !label) {
      return res.status(400).json({ error: 'id and label are required' });
    }

    // Check if node exists
    if (topology.nodes.find(n => n.id === id)) {
      return res.status(400).json({ error: 'Node with this ID already exists' });
    }

    const newNode = {
      id,
      label,
      ip: ip || '',
      type: type || 'device',
      x: x || Math.random() * 500,
      y: y || Math.random() * 500,
      probeType: probeType || 'ping',
      probeTarget: probeTarget || '',
      icon: icon || 'device'
    };

    topology.nodes.push(newNode);
    saveTopology();

    // Log topology event
    logEvent('topology_node_added', 'info', 'Topology', `Node "${newNode.label}" (${newNode.ip || 'no IP'}) added to topology`, {
      nodeId: newNode.id,
      nodeLabel: newNode.label,
      nodeIp: newNode.ip,
      nodeType: newNode.type
    });

    // Add to ping targets if it has probe settings
    if (newNode.probeType === 'ping' && newNode.probeTarget) {
      const exists = pingTargets.some(t => t.host === newNode.probeTarget);
      if (!exists) {
        const newId = Math.max(...pingTargets.map(t => t.id || 0), 0) + 1;
        pingTargets.push({
          id: newId,
          name: newNode.label,
          host: newNode.probeTarget,
          group: 'Topology',
          enabled: true,
          sourceNodeId: newNode.id
        });
        savePingTargets();
        console.log(`✓ Added topology node to ping targets: ${newNode.label} (${newNode.probeTarget})`);
      }
    }

    res.json({
      success: true,
      message: 'Node created successfully',
      node: newNode
    });
  } catch (err) {
    console.error('Error creating topology node:', err);
    res.status(500).json({ error: 'Failed to create node' });
  }
});

// PUT update topology node
app.put('/api/topology/nodes/:id', (req, res) => {
  try {
    const nodeId = req.params.id;
    const { label, ip, type, x, y, probeType, probeTarget, icon } = req.body;

    const node = topology.nodes.find(n => n.id === nodeId);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const oldProbeTarget = node.probeTarget;

    if (label !== undefined) node.label = label;
    if (ip !== undefined) node.ip = ip;
    if (type !== undefined) node.type = type;
    if (x !== undefined) node.x = x;
    if (y !== undefined) node.y = y;
    if (probeType !== undefined) node.probeType = probeType;
    if (probeTarget !== undefined) node.probeTarget = probeTarget;
    if (icon !== undefined) node.icon = icon;

    saveTopology();

    // Log topology event
    logEvent('topology_node_updated', 'info', 'Topology', `Node "${node.label}" updated`, {
      nodeId: node.id,
      nodeLabel: node.label,
      changes: {
        label: label !== undefined ? { from: node.label, to: label } : undefined,
        ip: ip !== undefined ? { from: node.ip, to: ip } : undefined,
        type: type !== undefined ? { from: node.type, to: type } : undefined,
        probeTarget: probeTarget !== undefined ? { from: oldProbeTarget, to: probeTarget } : undefined
      }
    });

    // Update ping targets if probe target changed
    if (probeTarget !== undefined && probeTarget !== oldProbeTarget) {
      // Remove old target if it exists and has no other sources
      if (oldProbeTarget) {
        const oldIndex = pingTargets.findIndex(t => t.host === oldProbeTarget);
        if (oldIndex !== -1) {
          const otherSources = topology.nodes.filter(n => n.id !== nodeId && n.probeTarget === oldProbeTarget);
          if (otherSources.length === 0) {
            pingTargets.splice(oldIndex, 1);
            console.log(`✓ Removed ping target: ${oldProbeTarget}`);
          }
        }
      }

      // Add new target if it doesn't exist
      if (probeTarget && node.probeType === 'ping') {
        const exists = pingTargets.some(t => t.host === probeTarget);
        if (!exists) {
          const newId = Math.max(...pingTargets.map(t => t.id || 0), 0) + 1;
          pingTargets.push({
            id: newId,
            name: node.label,
            host: probeTarget,
            group: 'Topology',
            enabled: true,
            sourceNodeId: node.id
          });
          console.log(`✓ Added ping target: ${probeTarget}`);
        }
      }

      savePingTargets();
    }

    res.json({
      success: true,
      message: 'Node updated successfully',
      node: node
    });
  } catch (err) {
    console.error('Error updating topology node:', err);
    res.status(500).json({ error: 'Failed to update node' });
  }
});

// DELETE topology node
app.delete('/api/topology/nodes/:id', (req, res) => {
  try {
    const nodeId = req.params.id;
    const index = topology.nodes.findIndex(n => n.id === nodeId);

    if (index === -1) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const node = topology.nodes[index]; // Get node before deletion
    const linksBefore = topology.links.length;

    // Remove node
    topology.nodes.splice(index, 1);

    // Remove links connected to this node
    topology.links = topology.links.filter(l => l.source !== nodeId && l.target !== nodeId);

    saveTopology();

    // Log topology event
    logEvent('topology_node_deleted', 'warning', 'Topology', `Node "${node.label}" deleted from topology`, {
      nodeId: nodeId,
      nodeLabel: node.label,
      nodeIp: node.ip,
      linksRemoved: linksBefore - topology.links.length
    });

    res.json({
      success: true,
      message: 'Node deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting topology node:', err);
    res.status(500).json({ error: 'Failed to delete node' });
  }
});

// POST create new topology link
app.post('/api/topology/links', (req, res) => {
  try {
    const { id, source, target, label, bwMonitor, latencyThreshold, description } = req.body;

    if (!id || !source || !target) {
      return res.status(400).json({ error: 'id, source, and target are required' });
    }

    // Verify nodes exist
    if (!topology.nodes.find(n => n.id === source)) {
      return res.status(400).json({ error: 'Source node not found' });
    }
    if (!topology.nodes.find(n => n.id === target)) {
      return res.status(400).json({ error: 'Target node not found' });
    }

    // Check if link exists
    if (topology.links.find(l => l.id === id)) {
      return res.status(400).json({ error: 'Link with this ID already exists' });
    }

    const newLink = {
      id,
      source,
      target,
      label: label || '',
      bwMonitor: bwMonitor || false,
      latencyThreshold: latencyThreshold || 100,
      description: description || ''
    };

    topology.links.push(newLink);
    saveTopology();

    // Log topology event
    const sourceNode = topology.nodes.find(n => n.id === source);
    const targetNode = topology.nodes.find(n => n.id === target);
    logEvent('topology_link_added', 'info', 'Topology', `Link created between "${sourceNode?.label || source}" and "${targetNode?.label || target}"`, {
      linkId: newLink.id,
      sourceNode: source,
      targetNode: target,
      sourceLabel: sourceNode?.label,
      targetLabel: targetNode?.label,
      linkLabel: newLink.label
    });

    res.json({
      success: true,
      message: 'Link created successfully',
      link: newLink
    });
  } catch (err) {
    console.error('Error creating topology link:', err);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// PUT update topology link
app.put('/api/topology/links/:id', (req, res) => {
  try {
    const linkId = req.params.id;
    const { label, bwMonitor, latencyThreshold, description } = req.body;

    const link = topology.links.find(l => l.id === linkId);
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    if (label !== undefined) link.label = label;
    if (bwMonitor !== undefined) link.bwMonitor = bwMonitor;
    if (latencyThreshold !== undefined) link.latencyThreshold = latencyThreshold;
    if (description !== undefined) link.description = description;

    saveTopology();

    // Log topology event
    const sourceNode = topology.nodes.find(n => n.id === link.source);
    const targetNode = topology.nodes.find(n => n.id === link.target);
    logEvent('topology_link_updated', 'info', 'Topology', `Link between "${sourceNode?.label || link.source}" and "${targetNode?.label || link.target}" updated`, {
      linkId: link.id,
      sourceNode: link.source,
      targetNode: link.target,
      changes: {
        label: label !== undefined ? { from: link.label, to: label } : undefined,
        latencyThreshold: latencyThreshold !== undefined ? { from: link.latencyThreshold, to: latencyThreshold } : undefined,
        description: description !== undefined ? { from: link.description, to: description } : undefined
      }
    });

    res.json({
      success: true,
      message: 'Link updated successfully',
      link: link
    });
  } catch (err) {
    console.error('Error updating topology link:', err);
    res.status(500).json({ error: 'Failed to update link' });
  }
});

// DELETE topology link
app.delete('/api/topology/links/:id', (req, res) => {
  try {
    const linkId = req.params.id;
    const index = topology.links.findIndex(l => l.id === linkId);

    if (index === -1) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const link = topology.links[index]; // Get link before deletion

    topology.links.splice(index, 1);
    saveTopology();

    // Log topology event
    const sourceNode = topology.nodes.find(n => n.id === link.source);
    const targetNode = topology.nodes.find(n => n.id === link.target);
    logEvent('topology_link_deleted', 'warning', 'Topology', `Link between "${sourceNode?.label || link.source}" and "${targetNode?.label || link.target}" deleted`, {
      linkId: linkId,
      sourceNode: link.source,
      targetNode: link.target,
      sourceLabel: sourceNode?.label,
      targetLabel: targetNode?.label,
      linkLabel: link.label
    });

    res.json({
      success: true,
      message: 'Link deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting topology link:', err);
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// Prometheus Metrics Endpoint
app.get('/metrics', (req, res) => {
  let metrics = '';

  // System Metrics
  const os = require('os');
  const uptime = os.uptime();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;

  // CPU Usage
  const cpus = os.cpus();
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

  metrics += '# HELP smon_system_uptime_seconds System uptime in seconds\n';
  metrics += '# TYPE smon_system_uptime_seconds gauge\n';
  metrics += `smon_system_uptime_seconds ${uptime}\n\n`;

  metrics += '# HELP smon_system_cpu_usage_percent CPU usage percentage\n';
  metrics += '# TYPE smon_system_cpu_usage_percent gauge\n';
  metrics += `smon_system_cpu_usage_percent ${cpuUsage}\n\n`;

  metrics += '# HELP smon_system_memory_used_bytes Memory used in bytes\n';
  metrics += '# TYPE smon_system_memory_used_bytes gauge\n';
  metrics += `smon_system_memory_used_bytes ${usedMemory}\n\n`;

  metrics += '# HELP smon_system_memory_total_bytes Total memory in bytes\n';
  metrics += '# TYPE smon_system_memory_total_bytes gauge\n';
  metrics += `smon_system_memory_total_bytes ${totalMemory}\n\n`;

  // Device Status Metrics
  metrics += '# HELP smon_device_status Device status (1=up, 0=down)\n';
  metrics += '# TYPE smon_device_status gauge\n';
  Object.values(snmpDevices).forEach(device => {
    const status = device.enabled ? 1 : 0;
    metrics += `smon_device_status{device_id="${device.id}",device_name="${device.name}",device_host="${device.host}"} ${status}\n`;
  });
  metrics += '\n';

  // Ping Target Metrics
  metrics += '# HELP smon_ping_target_status Ping target status (1=alive, 0=dead)\n';
  metrics += '# TYPE smon_ping_target_status gauge\n';

  metrics += '# HELP smon_ping_target_latency_ms Ping target latency in milliseconds\n';
  metrics += '# TYPE smon_ping_target_latency_ms gauge\n';

  metrics += '# HELP smon_ping_target_packet_loss_percent Ping target packet loss percentage\n';
  metrics += '# TYPE smon_ping_target_packet_loss_percent gauge\n';

  pingTargets.forEach(target => {
    if (target.enabled && target.latest) {
      const status = target.latest.alive ? 1 : 0;
      const latency = target.latest.time || 0;
      const packetLoss = target.latest.packetLoss || 0;

      metrics += `smon_ping_target_status{target_id="${target.id}",target_name="${target.name}",target_host="${target.host}",group="${target.group}"} ${status}\n`;
      metrics += `smon_ping_target_latency_ms{target_id="${target.id}",target_name="${target.name}",target_host="${target.host}",group="${target.group}"} ${latency}\n`;
      metrics += `smon_ping_target_packet_loss_percent{target_id="${target.id}",target_name="${target.name}",target_host="${target.host}",group="${target.group}"} ${packetLoss}\n`;
    }
  });
  metrics += '\n';

  // Website Monitoring Metrics
  metrics += '# HELP smon_website_status Website status (1=up, 0=down)\n';
  metrics += '# TYPE smon_website_status gauge\n';

  metrics += '# HELP smon_website_response_time_ms Website response time in milliseconds\n';
  metrics += '# TYPE smon_website_response_time_ms gauge\n';

  metrics += '# HELP smon_website_ssl_expiry_days SSL certificate expiry days remaining\n';
  metrics += '# TYPE smon_website_ssl_expiry_days gauge\n';

  websiteTargets.forEach(target => {
    if (target.enabled && target.latest) {
      const status = target.latest.status === 'up' ? 1 : 0;
      const responseTime = target.latest.responseTime || 0;
      const sslDays = target.latest.sslDaysRemaining || 0;

      metrics += `smon_website_status{target_id="${target.id}",target_name="${target.name}",target_url="${target.url}",group="${target.group}"} ${status}\n`;
      metrics += `smon_website_response_time_ms{target_id="${target.id}",target_name="${target.name}",target_url="${target.url}",group="${target.group}"} ${responseTime}\n`;
      metrics += `smon_website_ssl_expiry_days{target_id="${target.id}",target_name="${target.name}",target_url="${target.url}",group="${target.group}"} ${sslDays}\n`;
    }
  });
  metrics += '\n';

  // Domain Monitoring Metrics
  metrics += '# HELP smon_domain_status Domain status (1=active, 0=expired)\n';
  metrics += '# TYPE smon_domain_status gauge\n';

  metrics += '# HELP smon_domain_expiry_days Domain expiry days remaining\n';
  metrics += '# TYPE smon_domain_expiry_days gauge\n';

  metrics += '# HELP smon_domain_auto_renew Domain auto-renew status (1=enabled, 0=disabled)\n';
  metrics += '# TYPE smon_domain_auto_renew gauge\n';

  domainTargets.forEach(domain => {
    if (domain.enabled) {
      const daysLeft = Math.ceil((new Date(domain.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
      const status = daysLeft > 0 ? 1 : 0;
      const autoRenew = domain.auto_renew ? 1 : 0;

      metrics += `smon_domain_status{domain_id="${domain.id}",domain_name="${domain.name}",registrar="${domain.registrar}",group="${domain.group}"} ${status}\n`;
      metrics += `smon_domain_expiry_days{domain_id="${domain.id}",domain_name="${domain.name}",registrar="${domain.registrar}",group="${domain.group}"} ${daysLeft}\n`;
      metrics += `smon_domain_auto_renew{domain_id="${domain.id}",domain_name="${domain.name}",registrar="${domain.registrar}",group="${domain.group}"} ${autoRenew}\n`;
    }
  });
  metrics += '\n';

  // Event Counters
  const eventStats = {
    total: eventHistory.length,
    critical: eventHistory.filter(e => e.severity === 'critical').length,
    warning: eventHistory.filter(e => e.severity === 'warning').length,
    info: eventHistory.filter(e => e.severity === 'info').length,
    error: eventHistory.filter(e => e.severity === 'error').length
  };

  metrics += '# HELP smon_events_total Total number of events\n';
  metrics += '# TYPE smon_events_total counter\n';
  metrics += `smon_events_total ${eventStats.total}\n\n`;

  metrics += '# HELP smon_events_by_severity Events by severity level\n';
  metrics += '# TYPE smon_events_by_severity gauge\n';
  metrics += `smon_events_by_severity{severity="critical"} ${eventStats.critical}\n`;
  metrics += `smon_events_by_severity{severity="warning"} ${eventStats.warning}\n`;
  metrics += `smon_events_by_severity{severity="error"} ${eventStats.error}\n`;
  metrics += `smon_events_by_severity{severity="info"} ${eventStats.info}\n\n`;

  // Set proper headers for Prometheus
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(metrics);
});

// Test routes for error handling (remove in production)
app.get('/test-404', (req, res, next) => {
  next(); // This will trigger 404 handler
});

app.get('/test-500', (req, res, next) => {
  const error = new Error('Test internal server error');
  error.status = 500;
  next(error);
});

// Error handling middleware
// 404 Not Found handler
app.use((req, res, next) => {
  const error = new Error(`Route ${req.originalUrl} not found`);
  error.status = 404;
  next(error);
});

// 500 Internal Server Error handler
app.use((err, req, res, next) => {
  // Log error for debugging
  console.error('Error occurred:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });

  // Set status code
  const statusCode = err.status || err.statusCode || 500;

  // Check if request accepts HTML
  const acceptsHTML = req.accepts('html');

  if (acceptsHTML && statusCode === 404) {
    // Send 404 HTML page
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  } else if (acceptsHTML && statusCode === 500) {
    // Send 500 HTML page
    res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
  } else {
    // Send JSON response for API requests
    res.status(statusCode).json({
      error: {
        message: statusCode === 500 ? 'Internal Server Error' : err.message,
        status: statusCode,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
      }
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);

  // Load topology on startup
  loadTopology();

  // Start ping monitoring immediately
  startPingMonitoring();

  // Start website monitoring immediately
  startWebsiteMonitoring();

  // Start SNMP polling immediately
  startPolling();
});




