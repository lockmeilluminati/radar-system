import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 DEEP SCAN ---");
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        
        const prefix = `${year}/${month}/${day}/KLSX/`;
        console.log(`[SYSTEM] Accessing NOAA Sector: ${prefix}`);

        const listUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix=${prefix}`;
        const response = await fetch(listUrl);
        
        if (!response.ok) {
            console.error(`[ERROR] NOAA Server Rejected Request: ${response.status}`);
            return;
        }

        const xmlText = await response.text();
        // Regex to pull the file keys out of the XML
        const keys = [...xmlText.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
        const validScans = keys.filter(k => k.endsWith('V06') && !k.endsWith('_MDM'));

        console.log(`[SYSTEM] Discovery: Found ${keys.length} total files, ${validScans.length} valid radar binaries.`);

        if (validScans.length === 0) {
            console.log("[ALERT] Sector empty. Station may be offline or in a data gap.");
            // Log the first 200 chars of the response to see if it's an error message
            console.log(`[DEBUG] Raw Response Snippet: ${xmlText.substring(0, 200)}`);
            return;
        }

        validScans.sort();
        const targetScanKey = validScans[validScans.length - 1];
        console.log(`[SUCCESS] Intercepting Transmission: ${targetScanKey}`);

        // THE RAM UPLINK: Streaming the binary directly to memory
        const fileResponse = await fetch(`https://noaa-nexrad-level2.s3.amazonaws.com/${targetScanKey}`);
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());
        
        console.log(`[SYSTEM] Memory Load: ${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB locked in RAM.`);

        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                if (record.reflect && record.reflect.moment_data) {
                    record.reflect.moment_data.forEach((dbz, gateIndex) => {
                        if (dbz !== null && dbz >= 20) { // Slightly higher threshold for cleaner data
                            stormPoints.push({ a: record.azimuth, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            const docName = `STORM_${year}-${month}-${day}_${String(now.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(tacticalPayload),
                timestamp: Date.now(),
                sensor: "KLSX"
            });
            console.log(`[LOCKED] Data uploaded to Cabinet: ${docName}`);
        }
    } catch (err) {
        console.error("MISSION FAILURE:", err);
    }
}
executeTacticalSweep();
