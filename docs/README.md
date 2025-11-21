# SNMP InfluxDB Time Series Graph

Aplikasi web untuk menampilkan grafik time series dari data SNMP yang disimpan di InfluxDB.

## Setup

1. Install dependencies: `npm install`
2. Konfigurasi InfluxDB: Update token, org, bucket, dan URL di `app.js`
3. Konfigurasi SNMP: Update host dan community di `app.js`
4. Jalankan server: `npm start`

## Fitur

- Polling data SNMP setiap 60 detik
- Simpan data ke InfluxDB
- Tampilkan grafik time series menggunakan Chart.js
- Layout dengan sidebar dan main content menggunakan TailwindCSS

## Teknologi

- Backend: Express.js
- Frontend: EJS, TailwindCSS, Chart.js
- Database: InfluxDB
- Protocol: SNMP