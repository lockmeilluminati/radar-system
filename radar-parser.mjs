import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import zlib from 'zlib';

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 BLIND GRAB INTERCEPT ---");
        
        // Back to the proven root directory (No date folders to 404 on)
        const iemBaseUrl = "https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/";
        console.log(`[SYSTEM] Accessing Open Directory: ${iemBaseUrl}`);

        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Mirror Unavailable: ${response.status}`);
        
        const html = await response.text();
        
        // 1. The Blind Grab Regex
        // Grabs every href link in the Apache directory listing
        const filePattern = /href="([^"]+)"/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[1]);
        
        // 2. Filter out the Apache sorting buttons and parent directories
        const validFiles = matches.filter(name => 
            name.includes('KLSX') && 
            !name.includes('?C=') && 
            !name.includes('/')
        );

        if (validFiles.length === 0) {
            console.log("[ALERT] Sector completely empty. Printing raw HTML for diagnostic:");
            console.log(html.substring(0, 500)); 
            return;
        }

        // Grab the absolute last file in the sorted list (the newest transmission)
        const targetFile = validFiles.sort().pop(); 
        console.log(`[SUCCESS] Intercepted Raw Transmission: ${targetFile}`);

        // 3. THE RAM UPLINK
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        let rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        // Tactical Decompression if the server happens to zip it
        if (targetFile.endsWith('.gz')) {
            rawBuffer = zlib.gunzipSync(rawBuffer);
            console.log(`[SYSTEM] Decompressed .gz binary in RAM.`);
        }

        // 4. Parse and process
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        // Capturing intensity thresholds
                        if (dbz >= 18) {
                            stormPoints.push({ 
                                a: msg.record.azimuth, 
                                g: i, 
                                v: Math.round(dbz) 
                            });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const payload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            
            const now = new Date();
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            const docName = `STORM_2026-05-06_${String(now.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `IEM_NEXRAD://${targetFile}`
            });

            console.log(`[LOCKED] 2026 Data Deployed to Cabinet: ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
    }
}

executeTacticalSweep();
