const express = require('express');
const path = require('path');
const fs = require('fs');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const snmp = require('net-snmp');

const app = express();
const port = 3000;

// Load SNMP devices config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const snmpSessions = {}; // Map of device sessions
const snmpDevices = {}; // Map of device config

// Initialize SNMP sessions for enabled devices
config.snmpDevices.forEach(device => {
  if (device.enabled) {
    snmpDevices[device.id] = device;
    snmpSessions[device.id] = snmp.createSession(device.host, device.community, {
      timeout: 1000,
      retries: 0
    });
    console.log(`SNMP Session initialized for device: ${device.name} (${device.host})`);
  }
});

// InfluxDB configuration
const token = 'Sag1KBQNatpHmaMDoCDLB1Vrt-QAMTfwL_K13gRYjUihTrzlRSOdoDB9HwH6imIJpSMz4XgfG9AEAL4FtwUZpQ==';
const org = 'indobsd';
const bucket = 'graphts';
const url = 'http://localhost:8086';

const client = new InfluxDB({ url, token });
const queryApi = client.getQueryApi(org);

// Express configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Settings configuration
let settings = {
  pollingInterval: 300000 // 5 minutes in milliseconds
};

// Load or create settings file
const settingsFile = './settings.json';
if (fs.existsSync(settingsFile)) {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} else {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
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

// Route for dashboard page
app.get('/', (req, res) => {
  // Get all interfaces from all devices for total count
  let allInterfaces = [];
  Object.values(snmpDevices).forEach(device => {
    if (device.selectedInterfaces) {
      allInterfaces = allInterfaces.concat(device.selectedInterfaces);
    }
  });
  
  res.render('index', { 
    devices: snmpDevices,
    interfaces: allInterfaces
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
    pollingIntervalSeconds: settings.pollingInterval / 1000
  });
});

// Route for bandwidth monitoring page
app.get('/monitoring', async (req, res) => {
  try {
    console.log('Route /monitoring called');
    const deviceId = req.query.device || Object.keys(snmpDevices)[0] || null;
    
    if (!deviceId || !snmpDevices[deviceId]) {
      return res.status(400).send('Device not found');
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
    dataRetention: settings.dataRetention || 30
  });
});

// API to update settings
app.post('/api/settings', (req, res) => {
  try {
    const { pollingIntervalSeconds, dataRetentionDays } = req.body;
    
    if (pollingIntervalSeconds) {
      if (pollingIntervalSeconds < 10) {
        return res.status(400).json({ error: 'Polling interval must be at least 10 seconds' });
      }
      // Convert seconds to milliseconds
      const newInterval = pollingIntervalSeconds * 1000;
      settings.pollingInterval = newInterval;
    }
    
    if (dataRetentionDays !== undefined) {
      if (dataRetentionDays < 1 || dataRetentionDays > 365) {
        return res.status(400).json({ error: 'Data retention must be between 1 and 365 days' });
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
        dataRetention: settings.dataRetention
      }
    });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
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
      timeout: 3000,
      retries: 0
    });

    const interfaces = [];
    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        tempSession.close();
        console.log(`[DISCOVER] SNMP walk timeout, found ${interfaces.length} interfaces`);
        res.json({ interfaces });
      }
    }, 5000); // 5 second timeout for discovery

    tempSession.walk('1.3.6.1.2.1.2.2.1.2', 30, function(varbinds) {
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
        console.log(`[DISCOVER] SNMP walk completed, found ${interfaces.length} interfaces`);
        res.json({ interfaces });
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
    const { id, name, host, community, selectedInterfaces } = req.body;
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
      enabled: true,
      selectedInterfaces: selectedInterfaces || []
    };
    
    snmpDevices[id] = newDevice;
    config.snmpDevices.push(newDevice);
    saveConfig();
    
    // Create SNMP session for new device
    snmpSessions[id] = snmp.createSession(host, community, {
      timeout: 1000,
      retries: 0
    });
    
    res.json(newDevice);
  } catch (err) {
    console.error('Error adding device:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API to delete device
app.delete('/api/devices/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!snmpDevices[deviceId]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    delete snmpDevices[deviceId];
    config.snmpDevices = config.snmpDevices.filter(d => d.id !== deviceId);
    saveConfig();
    
    // Close SNMP session
    if (snmpSessions[deviceId]) {
      delete snmpSessions[deviceId];
    }
    
    res.json({ message: 'Device deleted' });
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
      timeout: 1000,
      retries: 0
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
    
    getInterfaces(deviceId, (interfaces) => {
      res.json(interfaces);
    });
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

// Route for home
app.get('/', async (req, res) => {
  try {
    console.log('Route / called');
    const deviceId = req.query.device || Object.keys(snmpDevices)[0] || null;
    
    if (!deviceId || !snmpDevices[deviceId]) {
      return res.status(400).send('Device not found');
    }

    // Get interfaces for the selected device from config
    const selectedDevice = snmpDevices[deviceId];
    const interfaces = selectedDevice.selectedInterfaces || [];

    // For dashboard, just render without InfluxDB query - faster load
    // Query is only done in monitoring page
    res.render('index', { 
      devices: snmpDevices,
      selectedDevice: deviceId,
      interfaces: interfaces
    });
  } catch (err) {
    console.error('Route error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Route for data API
app.get('/api/data', async (req, res) => {
  try {
    console.log('Route /api/data called');
    const deviceId = req.query.device || Object.keys(snmpDevices)[0] || null;
    const interface = req.query.interface || 'all';
    const direction = req.query.direction || 'all'; // 'rx', 'tx', or 'all'
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
      from(bucket: "${bucket}")
      |> range(start: ${rangeStart}${rangeStop})
      |> filter(fn: (r) => r._measurement == "snmp_metric")
      |> filter(fn: (r) => r._field == "value")
      |> filter(fn: (r) => r.device == "${deviceId}")
    `;
    if (interface !== 'all') {
      query += ` |> filter(fn: (r) => r.interface == "${interface}")`;
    }
    if (direction !== 'all') {
      query += ` |> filter(fn: (r) => r.direction == "${direction}")`;
    }
    query += `
      |> derivative(unit: 1s, nonNegative: true)
      |> map(fn: (r) => ({ r with _value: r._value * 8.0 / 1000000.0 }))
    `;
    
    console.log('[API/DATA] Query:', query.substring(0, 300));
    const data = [];
    let hasError = false;
    let responded = false;
    queryApi.queryRows(query, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        data.push({ time: o._time, value: o._value });
      },
      error(error) {
        console.error('InfluxDB query error:', error);
        hasError = true;
        if (!responded) {
          responded = true;
          res.json([]);
        }
      },
      complete() {
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
function getInterfaces(deviceId, callback) {
  try {
    if (!snmpDevices[deviceId]) {
      console.error('Device not found:', deviceId);
      callback([]);
      return;
    }

    const device = snmpDevices[deviceId];
    // Handle both old format (array of strings) and new format (array of {index, name})
    const interfaces = (device.selectedInterfaces || []).map((iface, idx) => {
      if (typeof iface === 'string') {
        // Old format: just interface name, use position as index (fallback)
        return { index: idx + 1, name: iface };
      } else {
        // New format: {index, name}
        return { index: iface.index, name: iface.name };
      }
    });

    console.log(`[${deviceId}] Retrieved ${interfaces.length} interfaces from config`);
    callback(interfaces);
  } catch (err) {
    console.error('getInterfaces error:', err);
    callback([]);
  }
}

// SNMP polling function for all devices
function pollSNMP() {
  console.log('[POLLING] Function called');
  try {
    console.log(`[POLLING] Starting poll at ${new Date().toISOString()}`);
    
    Object.keys(snmpDevices).forEach(deviceId => {
    const device = snmpDevices[deviceId];
    
    // Skip if no interfaces selected
    if (!device.selectedInterfaces || device.selectedInterfaces.length === 0) {
      console.log(`[${deviceId}] No interfaces selected, skipping polling`);
      return;
    }
    
    getInterfaces(deviceId, (allInterfaces) => {
      // Get selected interface names (support both old and new format)
      const selectedNames = device.selectedInterfaces.map(iface => 
        typeof iface === 'string' ? iface : iface.name
      );
      
      // Only poll selected interfaces
      const ifacesToPoll = allInterfaces.filter(iface => selectedNames.includes(iface.name));
      
      ifacesToPoll.forEach(iface => {
        // Query both RX (inbound) and TX (outbound) traffic
        const rxOid = `1.3.6.1.2.1.2.2.1.10.${iface.index}`; // ifInOctets - RX
        const txOid = `1.3.6.1.2.1.2.2.1.16.${iface.index}`; // ifOutOctets - TX
        
        // Query RX traffic
        snmpSessions[deviceId].get([rxOid], function(rxError, rxVarbinds) {
          if (rxError) {
            console.error(`[${deviceId}] SNMP RX error for interface ${iface.name}:`, rxError);
          } else if (snmp.isVarbindError(rxVarbinds[0])) {
            console.error(`[${deviceId}] SNMP RX varbind error for ${iface.name}:`, snmp.varbindError(rxVarbinds[0]));
          } else {
            const rxValue = rxVarbinds[0].value;
            try {
              const writeApi = client.getWriteApi(org, bucket);
              const rxPoint = new Point('snmp_metric')
                .tag('device', deviceId)
                .tag('device_name', device.name)
                .tag('interface', iface.name)
                .tag('direction', 'rx')
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
        });
        
        // Query TX traffic
        snmpSessions[deviceId].get([txOid], function(txError, txVarbinds) {
          if (txError) {
            console.error(`[${deviceId}] SNMP TX error for interface ${iface.name}:`, txError);
          } else if (snmp.isVarbindError(txVarbinds[0])) {
            console.error(`[${deviceId}] SNMP TX varbind error for ${iface.name}:`, snmp.varbindError(txVarbinds[0]));
          } else {
            const txValue = txVarbinds[0].value;
            try {
              const writeApi = client.getWriteApi(org, bucket);
              const txPoint = new Point('snmp_metric')
                .tag('device', deviceId)
                .tag('device_name', device.name)
                .tag('interface', iface.name)
                .tag('direction', 'tx')
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
        });
      });
    });
  });
  } catch (err) {
    console.error('[POLLING] Error in pollSNMP:', err);
  }
}

// Data retention cleanup function
function cleanupOldData() {
  try {
    const retentionDays = settings.dataRetention || 30;
    const cutoffTime = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
    const cutoffIso = cutoffTime.toISOString();
    
    // Delete data older than retention period
    const deleteQuery = `
      from(bucket: "${bucket}")
        |> range(start: 1970-01-01T00:00:00Z, stop: ${cutoffIso})
        |> delete()
    `;
    
    const deleteApi = client.getDeleteApi();
    deleteApi.delete(cutoffTime.getTime(), new Date().getTime(), `_measurement="snmp_metric"`, bucket, org);
    
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
    cpuUsage: Math.max(0, Math.min(100, cpuUsage)) // Ensure between 0-100
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});


