import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

// --- CABINET AUTHENTICATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 GOOGLE CLOUD INTERCEPT ---");
        
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        
        // 1. Target the Google Cloud Mirror for NEXRAD
        const prefix = `${year}/${month}/${day}/KLSX/`;
        console.log(`[SYSTEM] Scanning GCS Bucket: gcp-public-data-nexrad-l2/o?prefix=${prefix}`);

        // GCS Public JSON API - This doesn't require a security handshake for public data
        const gcsListUrl = `https://storage.googleapis.com/storage/v1/b/gcp-public-data-nexrad-l2/o?prefix=${prefix}`;
        
        const response = await fetch(gcsListUrl);
        if (!response.ok) {
            throw new Error(`Google Cloud Rejection: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!data.items || data.items.length === 0) {
            console.log("[ALERT] Sector empty. GCS mirror may have a slight sync delay.");
            return;
        }

        // 2. Extract the newest V06 binary
        const validScans = data.items
            .filter(item => item.name.endsWith('V06') && !item.name.endsWith('_MDM'))
            .sort((a, b) => b.updated.localeCompare(a.updated));

        const targetScanKey = validScans[0].name;
        console.log(`[SUCCESS] Intercepted 2026 transmission from Google: ${targetScanKey}`);

        // 3. Download directly from the GCS public endpoint into RAM
        const downloadUrl = `https://storage.googleapis.com/gcp-public-data-nexrad-l2/${targetScanKey}`;
        const fileResponse = await fetch(downloadUrl);
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        console.log(`[SYSTEM] Memory Load: ${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB locked in RAM.`);

        // 4. Parse the radar binary
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                if (record.reflect && record.reflect.moment_data) {
                    record.reflect.moment_data.forEach((dbz, gateIndex) => {
                        if (dbz !== null && dbz >= 18) { 
                            stormPoints.push({ a: record.azimuth, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);

            const localNow = new Date();
            const mins = Math.floor(localNow.getMinutes() / 5) * 5;
            const docName = `STORM_${year}-${month}-${day}_${String(localNow.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `GCS://${targetScanKey}`
            });

            console.log(`[SUCCESS] Data locked in Cabinet -> ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
        process.exit(1);
    }
}

executeTacticalSweep();
