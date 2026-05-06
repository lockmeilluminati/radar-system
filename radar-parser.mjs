import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

// --- CABINET AUTHENTICATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 STEALTH INTERCEPT ---");
        
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        
        // NOAA Folders are UTC-based
        const prefix = `${year}/${month}/${day}/KLSX/`;
        console.log(`[SYSTEM] Accessing NOAA Sector: ${prefix} (UTC)`);

        // 1. Fetch the bucket directory with a Stealth User-Agent
        // Using the standard S3 XML endpoint
        const listUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/?prefix=${prefix}`;
        
        const response = await fetch(listUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
            console.error(`[ERROR] Tactical Rejection: ${response.status} ${response.statusText}`);
            // If we get a 403, we need to log the headers to see what S3 is demanding
            return;
        }

        const xmlText = await response.text();
        
        // 2. Extract and filter for the freshest V06 binaries
        const keys = [...xmlText.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
        const validScans = keys.filter(k => k.endsWith('V06') && !k.endsWith('_MDM'));

        console.log(`[SYSTEM] Discovery: Found ${keys.length} total objects, ${validScans.length} valid radar binaries.`);

        if (validScans.length === 0) {
            console.log("[ALERT] Sector empty. Checking NOAA status...");
            return;
        }

        // Sort to get the absolute newest file
        validScans.sort();
        const targetScanKey = validScans[validScans.length - 1];
        console.log(`[SUCCESS] Intercepted latest 2026 transmission: ${targetScanKey}`);

        // 3. Download the binary payload directly into memory
        const downloadUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/${targetScanKey}`;
        const fileResponse = await fetch(downloadUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        console.log(`[SYSTEM] Memory Load: ${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB locked in RAM.`);

        // 4. Parse the raw memory buffer
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                if (record.reflect && record.reflect.moment_data) {
                    record.reflect.moment_data.forEach((dbz, gateIndex) => {
                        // Threshold of 15-20 dBZ to capture atmospheric data without ground clutter
                        if (dbz !== null && dbz >= 18) { 
                            stormPoints.push({ a: record.azimuth, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            // Take top 1000 heaviest points
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);

            // Time stamping for the HUD timeline (Local Time)
            const localNow = new Date();
            const mins = Math.floor(localNow.getMinutes() / 5) * 5;
            const archiveTime = String(localNow.getHours()).padStart(2, '0') + String(mins).padStart(2, '0');
            const documentName = `STORM_${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}_${archiveTime}`;

            await db.collection("radar_archive").doc(documentName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX",
                source: targetScanKey
            });

            console.log(`[SUCCESS] Data locked in Cabinet -> ${documentName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error);
        process.exit(1);
    }
}

executeTacticalSweep();
