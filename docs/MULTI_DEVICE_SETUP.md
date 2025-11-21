# Multi-Device SNMP Setup Guide

## Overview
The application now supports multiple SNMP devices with centralized configuration management. Each device can be enabled/disabled independently, and the UI provides a device selector dropdown to switch between devices dynamically.

## Configuration

### File: `config.json`
Located in the project root, this file defines all SNMP devices:

```json
{
  "snmpDevices": [
    {
      "id": "router1",
      "name": "Router 1 (Mikrotik)",
      "host": "172.16.27.2",
      "community": "public",
      "enabled": true
    },
    {
      "id": "router2",
      "name": "Router 2",
      "host": "192.168.1.1",
      "community": "public",
      "enabled": false
    },
    {
      "id": "switch1",
      "name": "Switch 1",
      "host": "192.168.1.10",
      "community": "public",
      "enabled": false
    }
  ]
}
```

### Adding a New Device
To add a new SNMP device, add an entry to the `snmpDevices` array:

```json
{
  "id": "unique-device-id",
  "name": "Device Display Name",
  "host": "192.168.x.x",
  "community": "public",
  "enabled": true
}
```

- **id**: Unique identifier used in logs and data tags
- **name**: Display name shown in the device selector dropdown
- **host**: IP address or hostname of the SNMP device
- **community**: SNMP community string (usually "public")
- **enabled**: Set to `true` to activate polling, `false` to disable

## Architecture Changes

### Backend (`app.js`)

#### 1. Configuration Loading
```javascript
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const snmpSessions = {};  // Maps deviceId -> SNMP session
const snmpDevices = {};   // Maps deviceId -> device config
```

#### 2. Session Initialization
On startup, SNMP sessions are created only for enabled devices:
```javascript
config.snmpDevices.forEach(device => {
  if (device.enabled) {
    snmpDevices[device.id] = device;
    snmpSessions[device.id] = snmp.createSession(
      device.host, 
      device.community, 
      { timeout: 1000, retries: 0 }
    );
    console.log(`SNMP Session initialized for device: ${device.name}`);
  }
});
```

#### 3. Device Parameter in Routes
Both `/` and `/api/data` routes now accept a `device` query parameter:
- `/` - Main page with graphs
- `/api/data` - Data API for AJAX requests

```javascript
const deviceId = req.query.device || Object.keys(snmpDevices)[0] || null;
```

Defaults to the first enabled device if not specified.

#### 4. Database Tagging
Data written to InfluxDB includes device information:
```javascript
const point = new Point('snmp_metric')
  .tag('device', deviceId)           // Device ID (router1, router2, etc.)
  .tag('device_name', device.name)   // Friendly name
  .tag('interface', iface.name)      // Interface name
  .floatField('value', value);       // Bandwidth in octets
```

This allows filtering data by device in InfluxDB queries.

#### 5. Multi-Device Polling
The `pollSNMP()` function now iterates through all enabled devices:
```javascript
function pollSNMP() {
  Object.keys(snmpDevices).forEach(deviceId => {
    const device = snmpDevices[deviceId];
    getInterfaces(deviceId, (interfaces) => {
      interfaces.forEach(iface => {
        // Poll each interface for this device
        snmpSessions[deviceId].get([oid], function(error, varbinds) {
          // Write data tagged with device info
        });
      });
    });
  });
}
```

Polling occurs every 60 seconds for all enabled devices simultaneously.

#### 6. Per-Device Interface Discovery
The `getInterfaces(deviceId, callback)` function now accepts a device ID and uses the corresponding SNMP session:

```javascript
function getInterfaces(deviceId, callback) {
  const session = snmpSessions[deviceId];
  // Performs SNMP walk on this specific device
  // Returns array of {index, name} objects
}
```

### Frontend (`views/index.ejs`)

#### 1. Device Selector Dropdown
Added at the top of the main content area:
```html
<select id="device-selector">
  <% Object.entries(devices).forEach(([deviceId, device]) => { %>
    <option value="<%= deviceId %>" <%= deviceId === selectedDevice ? 'selected' : '' %>>
      <%= device.name %> (<%= device.host %>)
    </option>
  <% }); %>
</select>
```

Dynamically populated from the devices object passed from the backend.

#### 2. Device Change Handling
When user selects a different device, page reloads with the device parameter:
```javascript
document.getElementById('device-selector').addEventListener('change', function() {
  window.location.href = '/?device=' + encodeURIComponent(this.value);
});
```

#### 3. API Calls Include Device Parameter
When fetching data for charts, the device parameter is included:
```javascript
fetch(`/api/data?device=${encodeURIComponent(currentDevice)}&interface=${encodeURIComponent(iface)}`)
```

This ensures only data from the selected device is displayed.

## Data Flow

### Initialization
1. App reads `config.json`
2. Creates SNMP sessions for each enabled device
3. Starts polling timer (60-second interval)

### Polling Cycle
```
Timer Tick (every 60 seconds)
  ↓
For each enabled device:
  ├─ Call getInterfaces(deviceId)
  │   └─ SNMP walk to get list of interfaces
  ├─ For each interface:
  │   └─ SNMP get ifInOctets value
  │   └─ Write Point to InfluxDB with tags:
  │       device: deviceId
  │       device_name: friendly name
  │       interface: interface name
  └─ Repeat for next device
```

### User Interface
```
Home Page Load (GET /)
  ├─ Extract device parameter (or use default)
  ├─ Query InfluxDB filtered by device
  ├─ Call getInterfaces(deviceId)
  ├─ Render template with:
  │   ├─ devices map (all enabled devices)
  │   ├─ selectedDevice (current device ID)
  │   └─ interfaces list (for selected device)
  └─ Display dropdown selector + interface checklist

User Selects Interface
  └─ Click "Update Chart" button
      ├─ For each selected interface:
      │   └─ Fetch /api/data?device=X&interface=Y
      ├─ Collect all responses
      └─ Render multi-series Chart.js graph
```

## Example Usage

### Enable a Second Device
Edit `config.json`:
```json
{
  "id": "router2",
  "name": "Router 2",
  "host": "192.168.1.1",
  "community": "public",
  "enabled": true    // Changed from false to true
}
```

Restart the application:
```bash
npm start
```

The UI will now show "Router 2" in the device selector dropdown.

### Query Specific Device in InfluxDB
```flux
from(bucket: "graphts")
  |> range(start: -1h)
  |> filter(fn: (r) => r.device == "router1")  // Device-specific filter
  |> filter(fn: (r) => r.interface == "ether1")
```

### View Polling Logs
```bash
# Watch real-time polling output
npm start

# Example output:
# SNMP Session initialized for device: Router 1 (Mikrotik) (172.16.27.2)
# SNMP Session initialized for device: Router 2 (192.168.1.1)
# Server running at http://localhost:3000
# Route / called
# [router1] SNMP walk completed, interfaces found: 32
# [router2] SNMP walk completed, interfaces found: 24
# [router1] Data written for ether1
# [router2] Data written for eth0
```

## Performance Notes

- **SNMP Sessions**: One session per device, reused for all operations
- **Polling**: All devices polled in parallel every 60 seconds
- **InfluxDB**: One write request per (device, interface) pair per polling cycle
- **Memory**: Minimal overhead; sessions maintained in memory
- **Network**: Up to 33 interfaces × 2 devices = ~66 SNMP requests per cycle

## Troubleshooting

### Device Not Appearing in Dropdown
- Check that `enabled: true` is set in `config.json`
- Verify SNMP host is reachable: `ping 192.168.1.1`
- Check SNMP community string matches device configuration

### No Data for New Device
- Ensure device is enabled in config
- Check SNMP community string: `snmpget -v2c -c public 192.168.1.1 sysDescr.0`
- View logs for SNMP errors: `npm start`
- Verify InfluxDB is running: `curl http://localhost:8086/health`

### Missing Interfaces
- SNMP walk uses OID 1.3.6.1.2.1.2.2.1.2 (ifDescr)
- Check if device supports this OID: `snmpwalk -v2c -c public 192.168.1.1 1.3.6.1.2.1.2.2.1.2`
- Verify timeout settings in config (default: 5 seconds max per device)

## Future Enhancements

- [ ] InfluxDB retention policy per device
- [ ] Device health status indicators
- [ ] Alert thresholds per device
- [ ] Export graphs per device
- [ ] Device-specific interface grouping
- [ ] API endpoint for device management (add/remove without restart)
