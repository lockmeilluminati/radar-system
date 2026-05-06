import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

// --- CABINET AUTHENTICATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 LIVE INTERCEPT ---");
        
        const now = new Date();
        // Force UTC to match NOAA's server heartbeat
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        
        const prefix = `${year}/${month}/${day}/KLSX/`;
        console.log(`[SYSTEM] Target Sector: ${prefix} (UTC)`);

        // 1. Fetch the bucket directory
        const listUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix=${prefix}`;
        const listResponse = await fetch(listUrl);
        const xmlText = await listResponse.text();

        // 2. Extract and filter for the freshest V06 binaries
        const keys = [...xmlText.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
        const validScans = keys.filter(k => k.endsWith('V06') && !k.endsWith('_MDM'));

        if (validScans.length === 0) {
            console.log("[ALERT] Sector empty. Checking for upload delay...");
            // If empty, the station might be between uploads or in a maintenance window
            process.exit(0);
        }

        // Sort to get the absolute newest file
        validScans.sort();
        const targetScanKey = validScans[validScans.length - 1];
        console.log(`[SUCCESS] Intercepted latest 2026 transmission: ${targetScanKey}`);

        // 3. Download to RAM
        const downloadUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/${targetScanKey}`;
        const fileResponse = await fetch(downloadUrl);
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        // 4. Parse & Extract
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                if (record.reflect && record.reflect.moment_data) {
                    record.reflect.moment_data.forEach((dbz, gateIndex) => {
                        if (dbz !== null && dbz >= 15) { 
                            stormPoints.push({ a: record.azimuth, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            
            // Format time for the 5-minute timeline UI
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            const archiveTime = String(now.getHours()).padStart(2, '0') + String(mins).padStart(2, '0');
            const documentName = `STORM_${year}-${month}-${day}_${archiveTime}`;

            await db.collection("radar_archive").doc(documentName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX",
                source: targetScanKey
            });

            console.log(`[LOCKED] 2026 Data deployed to Cabinet: ${documentName}`);
        }
    } catch (error) {
        console.error("CRITICAL FAILURE:", error);
        process.exit(1);
    }
}

executeTacticalSweep();

