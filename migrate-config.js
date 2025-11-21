const snmp = require('net-snmp');
const fs = require('fs');

// Load config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

function discoverInterfaceIndexes(host, community, interfaceNames) {
  return new Promise((resolve) => {
    const session = snmp.createSession(host, community, { timeout: 5000, retries: 2 });
    const result = [];

    session.walk('1.3.6.1.2.1.2.2.1.2', function(error, varbinds) {
      if (error) {
        console.log(`[${host}] Walk error: ${error}`);
        session.close();
        resolve(result);
        return;
      }

      // Build map of interface name -> index
      const ifaceMap = {};
      for (let i = 0; i < varbinds.length; i++) {
        const varbind = varbinds[i];
        if (!snmp.isVarbindError(varbind)) {
          const interfaceDesc = varbind.value.toString();
          const oid = varbind.oid;
          const index = parseInt(oid.split('.').pop());
          ifaceMap[interfaceDesc] = index;
        }
      }

      // Map requested names to indexes
      interfaceNames.forEach(name => {
        if (ifaceMap[name]) {
          result.push({ index: ifaceMap[name], name });
        } else {
          console.log(`[${host}] Interface not found: ${name}`);
        }
      });

      session.close();
      resolve(result);
    });

    // Timeout after 6 seconds
    setTimeout(() => {
      session.close();
      resolve(result);
    }, 6000);
  });
}

async function migrateConfig() {
  console.log('Starting config migration...\n');

  for (const device of config.snmpDevices) {
    if (!device.enabled || device.selectedInterfaces.length === 0) {
      console.log(`[${device.id}] Skipped (not enabled or no interfaces)`);
      continue;
    }

    // Check if already migrated (format: {index, name})
    if (typeof device.selectedInterfaces[0] === 'object' && device.selectedInterfaces[0].index !== undefined) {
      console.log(`[${device.id}] Already migrated`);
      continue;
    }

    console.log(`[${device.id}] Discovering interface indexes for ${device.host}...`);
    
    try {
      const interfaceNames = device.selectedInterfaces;
      const discovered = await discoverInterfaceIndexes(device.host, device.community, interfaceNames);
      
      if (discovered.length === 0) {
        console.log(`[${device.id}] ⚠️  Failed to discover any interfaces`);
        continue;
      }

      // Update config with new format
      device.selectedInterfaces = discovered;
      console.log(`[${device.id}] ✅ Updated: ${discovered.map(i => `${i.name}(#${i.index})`).join(', ')}`);
    } catch (err) {
      console.error(`[${device.id}] Error: ${err.message}`);
    }

    // Small delay between devices
    await new Promise(r => setTimeout(r, 500));
  }

  // Save migrated config
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  console.log('\n✅ Config migration complete!');
  console.log('New config saved to config.json');
}

migrateConfig().catch(console.error);
