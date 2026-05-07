import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import zlib from 'zlib';

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING DYNAMIC BLIND GRAB INTERCEPT ---");
        
        // Target the proven root directory
        const iemBaseUrl = "https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/";
        console.log(`[SYSTEM] Accessing Open Directory: ${iemBaseUrl}`);

        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Mirror Unavailable: ${response.status}`);
        
        const html = await response.text();
        
        // 1. The Blind Grab Regex
        const filePattern = /href="([^"]+)"/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[1]);
        
        // 2. Filter valid radar files
        const validFiles = matches.filter(name => 
            name.includes('KLSX') && 
            !name.includes('?C=') && 
            !name.includes('/')
        );

        if (validFiles.length === 0) {
            console.log("[ALERT] Sector completely empty.");
            return;
        }

        // Grab the absolute last file in the sorted list (the newest transmission)
        const targetFile = validFiles.sort().pop(); 
        console.log(`[SUCCESS] Intercepted Raw Transmission: ${targetFile}`);

        // 3. THE RAM UPLINK
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        let rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        // Tactical Decompression
        if (targetFile.endsWith('.gz')) {
            rawBuffer = zlib.gunzipSync(rawBuffer);
            console.log(`[SYSTEM] Decompressed .gz binary in RAM.`);
        }

        // 4. Parse and process coordinates
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
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
            
            // 5. DYNAMIC TIMESTAMP EXTRACTION
            // Target File Format: KLSX_20260507_1307.gz
            const cleanName = targetFile.replace('.gz', '');
            const parts = cleanName.split('_');
            
            const dateStr = parts[1]; // e.g., "20260507"
            const timeStr = parts[2]; // e.g., "1307"
            
            const yyyy = dateStr.substring(0, 4);
            const mm = dateStr.substring(4, 6);
            const dd = dateStr.substring(6, 8);
            const hh = timeStr.substring(0, 2);
            
            // Format: STORM_2026-05-07_1300
            const docName = `STORM_${yyyy}-${mm}-${dd}_${hh}00`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `IEM_NEXRAD://${targetFile}`
            });

            console.log(`[LOCKED] Dynamic Data Deployed to Cabinet: ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
    }
}

executeTacticalSweep();
