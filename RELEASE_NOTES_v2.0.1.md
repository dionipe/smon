# SMon v2.0.1 - Bandwidth Fixes Release

## Release Date: December 3, 2025

### 🚀 What's New in v2.0.1

This patch release addresses critical bandwidth monitoring accuracy issues, particularly for high-speed network interfaces.

### 🔧 Key Improvements

- **Enhanced Counter Rollover Detection**: Improved handling of SNMP counter rollovers for interfaces exceeding 100 Mbps
- **64-bit Counter Support**: Added IF-MIB 64-bit counter support with automatic fallback to 32-bit counters
- **Smart Traffic Classification**: Better distinction between legitimate high-speed traffic and interface resets
- **Multi-Rollover Detection**: Support for detecting 1-20 counter rollovers for 10Gbps+ interfaces

### 🐛 Bug Fixes

- Fixed inaccurate bandwidth visualization for data exceeding 100 Mbps
- Resolved VLAN interfaces showing zero values due to false counter reset detection
- Fixed Ethernet/SFP+ interfaces not properly handling high-speed traffic
- Improved SNMP error handling and counter validation

### 📊 Technical Details

- Multiple rollover pattern matching for high-speed interfaces
- Enhanced delta calculation with proper polling interval accounting
- Better visualization scaling for high-bandwidth scenarios
- Reduced false positive counter resets

### 📈 Performance Improvements

- More accurate bandwidth calculations across all interface types
- Better chart rendering for high-traffic scenarios
- Improved data reliability for network monitoring

### 🔄 Migration Notes

- No breaking changes - fully backward compatible
- Automatic detection and use of 64-bit counters when available
- Existing configurations continue to work without modification

### 📋 Files Changed

- Updated version numbers across all UI components
- Enhanced counter rollover detection logic in app.js
- Improved SNMP polling with 64-bit counter support

---

**Checksums and Verification:**
- Commit: afa1cc5ca5d580a11beda41d5aef7d70a89bc98d
- Tag: v2.0.1
- Previous Version: v2.0

For questions or issues, please refer to the project documentation or create an issue in the repository.
