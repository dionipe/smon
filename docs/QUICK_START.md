# SNMP Time Series Graph - Multi-Device Implementation

## 🎉 Implementation Complete!

Your application now has **full multi-device SNMP monitoring** with persistent configuration and per-device interface selection.

---

## 📋 What Was Implemented

### Core Features
1. ✅ **Device Management Interface** (`/devices`)
   - Add new SNMP devices with IP, community string
   - Auto-discover interfaces via SNMP walk
   - Select which interfaces to monitor per device
   - Delete devices
   - Persistent configuration in config.json

2. ✅ **Graph Viewing** (`/`)
   - Device selector dropdown
   - Multi-interface checklist
   - Real-time bandwidth charts (kbps)
   - 24-hour time format

3. ✅ **Smart Polling**
   - Only collects data for selected interfaces
   - Reduces network load and database usage
   - Skips devices with no interfaces selected
   - Maintains per-device SNMP sessions

4. ✅ **REST APIs**
   - Device CRUD operations
   - Interface discovery
   - Configuration persistence
   - Time series data retrieval

---

## 🚀 Quick Start

### 1. Navigate to Device Management
```
http://localhost:3000/devices
```

### 2. Configure Device (Pre-configured: Router 1 - Mikrotik)
- The main device (172.16.27.2) is already set up
- Click "Refresh Interfaces" to discover interfaces
- Select interfaces you want to monitor (e.g., ether1, ether2, ether3)
- Click "Save Selection"

### 3. View Graphs
```
http://localhost:3000/
```
- Select device from dropdown
- Check interfaces to display
- Click "Update Chart"

---

## 📊 Architecture

```
┌─────────────────────────────────────┐
│   SNMP Devices (Multiple)           │
│   - Router 1: 172.16.27.2 (Active)  │
│   - Router 2: 192.168.1.1           │
│   - Switch 1: 192.168.1.10          │
└────────────────┬────────────────────┘
                 │ SNMP Walk (Discovery)
                 │ SNMP Get (Polling)
                 ↓
    ┌────────────────────────────┐
    │  Express.js Backend        │
    │  ┌──────────────────────┐  │
    │  │ Device APIs          │  │
    │  │ - GET /api/devices   │  │
    │  │ - POST /api/devices  │  │
    │  │ - DELETE etc.        │  │
    │  └──────────────────────┘  │
    │  ┌──────────────────────┐  │
    │  │ SNMP Sessions Map    │  │
    │  │ - device1: session   │  │
    │  │ - device2: session   │  │
    │  │ - deviceN: session   │  │
    │  └──────────────────────┘  │
    └────────────────────────────┘
                 │
        ┌────────┴─────────┐
        ↓                  ↓
    ┌─────────┐       ┌──────────────┐
    │ config  │       │  InfluxDB    │
    │ .json   │       │  v2 graphts  │
    │         │       │  bucket      │
    └─────────┘       └──────────────┘
        │                  │
        └────────┬─────────┘
                 ↓
    ┌─────────────────────────┐
    │   Frontend (EJS)        │
    │ /devices - Management   │
    │ / - Graphs              │
    └─────────────────────────┘
```

---

## 📁 Project Structure

```
/home/dionipe/graphts/
├── app.js                      Main Express server
│   ├── Device APIs
│   ├── SNMP Session Management
│   ├── Smart Polling Logic
│   └── Graph Data Endpoints
│
├── config.json                 Device configurations (persistent)
│   └── snmpDevices[]
│       ├── id
│       ├── name
│       ├── host
│       ├── community
│       ├── enabled
│       └── selectedInterfaces
│
├── views/
│   ├── index.ejs              Graph viewing page
│   │   ├── Device selector
│   │   ├── Interface checklist
│   │   ├── Chart.js canvas
│   │   └── Auto-update script
│   │
│   └── devices.ejs (NEW)      Device management page
│       ├── Add device form
│       ├── Interface discovery
│       ├── Selection UI
│       └── Delete functionality
│
├── package.json               Dependencies
├── README.md                  Original documentation
├── MULTI_DEVICE_GUIDE.md      Multi-device usage guide
└── IMPLEMENTATION_COMPLETE.md Implementation details

```

---

## 🔧 Configuration (config.json)

```json
{
  "snmpDevices": [
    {
      "id": "router1",
      "name": "Router 1 (Mikrotik)",
      "host": "172.16.27.2",
      "community": "public",
      "enabled": true,
      "selectedInterfaces": ["ether1", "ether2", "ether3"]
    },
    {
      "id": "router2",
      "name": "Router 2",
      "host": "192.168.1.1",
      "community": "public",
      "enabled": false,
      "selectedInterfaces": []
    }
  ]
}
```

---

## 🌐 API Reference

### Device Management

**List all devices:**
```bash
GET /api/devices
Response: { "router1": {...}, "router2": {...} }
```

**Add new device:**
```bash
POST /api/devices
Body: {
  "id": "router3",
  "name": "Router 3",
  "host": "192.168.1.20",
  "community": "public"
}
```

**Delete device:**
```bash
DELETE /api/devices/router1
```

**Get device interfaces:**
```bash
GET /api/devices/router1/interfaces
Response: [
  { "index": 1, "name": "ether1" },
  { "index": 2, "name": "ether2" }
]
```

**Save interface selection:**
```bash
POST /api/devices/router1/select-interfaces
Body: {
  "selectedInterfaces": ["ether1", "ether2", "ether3"]
}
```

### Graph Data

**Get time series data:**
```bash
GET /api/data?device=router1&interface=ether1
Response: [
  { "time": "2025-11-20T11:14:43Z", "value": 7431.535 },
  { "time": "2025-11-20T11:15:43Z", "value": 7516.277 }
]
```

---

## 📈 Data Collection

### Polling Details
- **Interval:** 60 seconds
- **OID Polled:** 1.3.6.1.2.1.2.2.1.10 (ifInOctets - Inbound Octets)
- **Conversion:** bytes → kbps (with derivative in Flux)
- **Filtering:** Only interfaces in `device.selectedInterfaces`

### InfluxDB Storage
```
Measurement: snmp_metric
Tags:
  - device: device_id
  - device_name: device_name
  - interface: interface_name
Fields:
  - value: octets_value
Time: timestamp
```

---

## 🎨 Frontend Capabilities

### Device Management Page (`/devices`)

**Features:**
- ✅ Add device form (ID, name, host, community)
- ✅ List all configured devices
- ✅ Auto-discover interfaces per device
- ✅ Checkbox interface selection
- ✅ Save/refresh buttons
- ✅ Delete device with confirmation
- ✅ Display current selection
- ✅ Error handling for SNMP failures

### Graph Viewing Page (`/`)

**Features:**
- ✅ Device dropdown selector
- ✅ Dynamic interface list
- ✅ Multi-interface checkboxes
- ✅ Chart.js visualization
- ✅ Real-time updates
- ✅ 24-hour time format
- ✅ Bandwidth in kbps
- ✅ Color-coded datasets
- ✅ Navigation to device management

---

## 🔌 SNMP Implementation

### Session Management
```javascript
// One SNMP session per device
snmpSessions = {
  "router1": snmp.createSession(...),
  "router2": snmp.createSession(...)
}

// Reused across polling cycles
// Maintained in memory for efficiency
```

### Interface Discovery
```javascript
// SNMP Walk on ifDescr OID
// Returns all interface names
// Filtered to .2 subtree (interface descriptions only)
// Includes port names, VLAN names, bridge names, etc.
```

### Data Collection
```javascript
// Only for selected interfaces
// SNMP GET on ifInOctets
// One GET per interface per polling cycle
// Results written to InfluxDB with device/interface tags
```

---

## ✅ Testing & Verification

All functionality tested:

| Component | Test | Result |
|-----------|------|--------|
| Device APIs | POST, GET, DELETE | ✅ Working |
| Interface Discovery | SNMP walk | ✅ Returns 20+ interfaces |
| Interface Selection | Save/Load | ✅ Persisted to config |
| Smart Polling | Only selected | ✅ Verified in logs |
| InfluxDB Write | Data insertion | ✅ Data in database |
| Graph API | Data retrieval | ✅ Returns time series |
| Frontend UI | Page loads | ✅ All pages render |
| Navigation | Links | ✅ All navigation works |

---

## 🔍 Monitoring & Debugging

### Check Server Logs
```bash
tail -f /tmp/server.log
```

### Sample Log Output
```
SNMP Session initialized for device: Router 1 (Mikrotik) (172.16.27.2)
[router1] Data written for ether1
[router1] Data written for ether2
[router1] Data written for ether3
```

### Verify SNMP Connectivity
```bash
# Test SNMP connection
snmpwalk -v 2c -c public 172.16.27.2 1.3.6.1.2.1.2.2.1.2
```

### Check InfluxDB Data
```bash
# Query InfluxDB
influx query 'from(bucket:"graphts") |> range(start: -1h)'
```

---

## 📱 Browser Access

- **Device Management:** `http://localhost:3000/devices`
- **View Graphs:** `http://localhost:3000/`
- **API Base:** `http://localhost:3000/api/`

---

## 🚨 Troubleshooting

### Device not showing interfaces
1. Check SNMP community string (default: "public")
2. Verify device IP is reachable (ping)
3. Check firewall allows UDP port 161
4. Check SNMP is enabled on device

### No data in graph
1. Wait 2-3 polling cycles (120-180 sec)
2. Verify interface is selected
3. Check device has traffic on interface
4. Query InfluxDB directly

### Server crashes
1. Check logs: `tail /tmp/server.log`
2. Verify all dependencies installed: `npm install`
3. Check port 3000 is available
4. Restart: `npm start`

---

## 🎯 Next Steps

### Use Case Ideas
1. **Monitor Multiple Routers:** Add all your SNMP devices
2. **Per-Interface Monitoring:** Select specific critical interfaces
3. **Bandwidth Tracking:** Monitor peak hours
4. **Capacity Planning:** Track growth over time
5. **Troubleshooting:** Identify problem interfaces

### Potential Improvements
- Add SNMP v3 support
- Custom OID polling
- Alert thresholds
- Historical reports
- Data export

---

## 📝 Summary

**What's Working:**
- ✅ Multi-device SNMP polling
- ✅ Per-device interface selection
- ✅ Persistent configuration
- ✅ Smart polling (only selected)
- ✅ Real-time graphing
- ✅ 24-hour time format
- ✅ Full REST API
- ✅ Error handling

**What You Can Do:**
1. Add new SNMP devices via `/devices` page
2. Select interfaces per device
3. View real-time bandwidth graphs on `/` page
4. Configuration is automatically persisted
5. Use REST API for automation

**Server Status:**
- ✅ Running on `http://localhost:3000`
- ✅ Polling every 60 seconds
- ✅ Writing to InfluxDB
- ✅ All endpoints functional

---

**Ready to use!** 🚀

Start by visiting `http://localhost:3000/devices` to manage your SNMP devices, or `http://localhost:3000/` to view graphs.

---

**Questions?** Check these files:
- `MULTI_DEVICE_GUIDE.md` - Detailed usage guide
- `IMPLEMENTATION_COMPLETE.md` - Technical implementation details
- `README.md` - Original project documentation
