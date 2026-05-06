import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

// --- CABINET AUTHENTICATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING LIVE SENSOR INTERCEPT ---");
        
        // 1. Calculate the UTC path for today's live data
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        const prefix = `${year}/${month}/${day}/KLSX/`;
        
        console.log(`[SYSTEM] Bypassing AWS Auth - Scanning NOAA Public Directory: ${prefix}`);

        // 2. Fetch the bucket directory listing via public HTTPS
        const listUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix=${prefix}`;
        const listResponse = await fetch(listUrl);
        const xmlText = await listResponse.text();

        // 3. Extract the filenames from the XML response
        const keys = [...xmlText.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
        const validScans = keys.filter(k => !k.endsWith('_MDM') && k.endsWith('V06'));

        if (validScans.length === 0) {
            console.log("[ALERT] No atmospheric data found in sector for today.");
            process.exit(0);
        }

        // Sort to ensure we grab the absolute latest file
        validScans.sort();
        const targetScanKey = validScans[validScans.length - 1];
        
        console.log(`[SUCCESS] Intercepted latest transmission: ${targetScanKey}`);

        // 4. Download the binary payload directly into memory
        const downloadUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/${targetScanKey}`;
        const fileResponse = await fetch(downloadUrl);
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        console.log(`[SYSTEM] Decoding ${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB of atmospheric data...`);

        // 5. Parse the raw memory buffer
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                const az = record.azimuth;
                const reflect = record.reflect;
                if (reflect && reflect.moment_data) {
                    reflect.moment_data.forEach((dbz, gateIndex) => {
                        if (dbz !== null && dbz >= 15) { 
                            stormPoints.push({ a: az, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            // Take top 1000 heaviest points
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);

            // Time stamping for the HUD timeline
            const localNow = new Date();
            const archiveDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;
            const mins = Math.floor(localNow.getMinutes() / 5) * 5;
            const archiveTime = String(localNow.getHours()).padStart(2, '0') + String(mins).padStart(2, '0');
            const documentName = `STORM_${archiveDate}_${archiveTime}`;

            await db.collection("radar_archive").doc(documentName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX",
                sourceFile: targetScanKey
            });

            console.log(`[SUCCESS] Data locked in Cabinet -> ${documentName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error);
        process.exit(1);
    }
}

executeTacticalSweep();
