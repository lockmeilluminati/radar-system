import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import zlib from 'zlib'; // Added to ensure .gz decompression is handled

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 DEEP VAULT INTERCEPT ---");
        
        // 1. Generate the UTC Date Path for 2026
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        
        // Target the specific date folder to avoid the "Sector Empty" lobby
        const iemBaseUrl = `https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/${year}/${month}/${day}/`;
        console.log(`[SYSTEM] Accessing Date Vault: ${iemBaseUrl}`);

        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Vault Locked: ${response.status}`);
        const html = await response.text();
        
        // 2. Extract the absolute latest binary
        const filePattern = /KLSX_\d{8}_\d{4}\.gz/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[0]);

        if (matches.length === 0) {
            console.log("[ALERT] No binaries found for this date yet. Check sync status.");
            return;
        }

        const targetFile = matches.sort().pop(); 
        console.log(`[SUCCESS] Intercepted 2026 Transmission: ${targetFile}`);

        // 3. THE RAM UPLINK: Fetch and Decompress
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        let rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        // Tactical Decompression: If it's a .gz file, unzip it in memory
        if (targetFile.endsWith('.gz')) {
            rawBuffer = zlib.gunzipSync(rawBuffer);
            console.log(`[SYSTEM] Decompressed: ${targetFile} -> RAM Binary`);
        }

        // 4. Parse and Deploy
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        if (dbz >= 18) {
                            stormPoints.push({ a: msg.record.azimuth, g: i, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const payload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            const docName = `STORM_2026-${month}-${day}_${String(now.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `IEM_NEXRAD://${targetFile}`
            });
            console.log(`[LOCKED] 2026 Data Uploaded: ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
    }
}
executeTacticalSweep();
