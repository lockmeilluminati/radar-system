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
        const prefix = `${year}/${month}/${day}/KLSX/`;

        // Using the direct public URL to bypass the AWS SDK's restrictive handshake
        const listUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix=${prefix}`;
        
        console.log(`[SYSTEM] Pulling Sector: ${prefix}`);

        const response = await fetch(listUrl, {
            method: 'GET',
            headers: {
                // This makes the GitHub server look like a standard Windows browser
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'application/xml'
            }
        });

        if (!response.ok) {
            throw new Error(`NOAA Rejection: ${response.status} ${response.statusText}`);
        }

        const xmlText = await response.text();
        const keys = [...xmlText.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
        const validScans = keys.filter(k => k.endsWith('V06') && !k.endsWith('_MDM'));

        if (validScans.length === 0) {
            console.log("[ALERT] Sector currently empty on NOAA servers.");
            return;
        }

        validScans.sort();
        const targetScanKey = validScans[validScans.length - 1];
        console.log(`[SUCCESS] Intercepted 2026 transmission: ${targetScanKey}`);

        // Download directly to RAM
        const fileResponse = await fetch(`https://noaa-nexrad-level2.s3.amazonaws.com/${targetScanKey}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

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
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            const docName = `STORM_${year}-${month}-${day}_${String(now.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(tacticalPayload),
                timestamp: Date.now(),
                sensor: "KLSX",
                source: targetScanKey
            });

            console.log(`[LOCKED] 2026 Data Uploaded: ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
        process.exit(1);
    }
}

executeTacticalSweep();
