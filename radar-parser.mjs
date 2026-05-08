import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';

// Authenticate with Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING SMARTER BOUNCER (10-MIN CYCLE) ---");
        
        const iemBaseUrl = "https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/";
        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Mirror Unavailable: ${response.status}`);
        
        const html = await response.text();
        const filePattern = /href="([^"]+)"/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[1]);
        
        const validFiles = matches.filter(name => 
            name.includes('KLSX') && !name.includes('?C=') && !name.includes('/')
        );

        if (validFiles.length === 0) return;

        const targetFile = validFiles.sort().pop(); 
        console.log(`[TARGET] Found Newest Transmission: ${targetFile}`);

        // Download Binary
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        const arrayBuffer = await fileResponse.arrayBuffer();
        let rawBuffer = Buffer.from(arrayBuffer);

        // Decompress
        if (targetFile.endsWith('.gz')) {
            rawBuffer = zlib.gunzipSync(rawBuffer);
        }

        // Decode Level 2 Telemetry
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        let type = "";
                        // SMARTER BOUNCER THRESHOLDS
                        if (dbz >= 50) { type = "HAIL"; }
                        else if (dbz >= 35) { type = "HEAVY_RAIN"; }
                        else if (dbz >= 20) { type = "LIGHT_RAIN"; }
                        else if (dbz >= 5) { type = "CLOUDS"; }

                        if (type !== "") {
                            stormPoints.push({ 
                                a: msg.record.azimuth, 
                                g: i, 
                                v: Math.round(dbz),
                                t: type 
                            });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            // PRIORITY SORT: Dangerous weather gets to the front of the line
            const payload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            
            // Snap to 10-minute floor (St. Louis Time)
            const parts = targetFile.replace('.gz', '').split('_');
            const radarDate = new Date(Date.UTC(
                parseInt(parts[1].substring(0, 4)),
                parseInt(parts[1].substring(4, 6)) - 1,
                parseInt(parts[1].substring(6, 8)),
                parseInt(parts[2].substring(0, 2)),
                parseInt(parts[2].substring(2, 4))
            ));
            
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/Chicago',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            
            const tz = formatter.formatToParts(radarDate).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
            const hh = tz.hour === '24' ? '00' : tz.hour;
            const snappedMin = Math.floor(parseInt(tz.minute) / 10) * 10;
            const mm = String(snappedMin).padStart(2, '0');

            const docName = `STORM_${tz.year}-${tz.month}-${tz.day}_${hh}${mm}`;
            console.log(`[UPLINK] Deploying ${payload.length} points to: radar_archive/${docName}`);

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now(),
                sensor: "KLSX"
            });

            console.log(`[LOCKED] Document is LIVE.`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
    }
}

executeTacticalSweep();
