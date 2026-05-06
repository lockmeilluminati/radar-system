import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

// --- CABINET AUTHENTICATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 SYNCHRONIZED INTERCEPT ---");
        
        // Target the NEW 2026 dedicated radar subdomain
        const iemBaseUrl = "https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/";
        console.log(`[SYSTEM] Accessing Dedicated High-Speed Mirror: ${iemBaseUrl}`);

        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Mirror Unavailable: ${response.status}`);

        const html = await response.text();
        
        // Extract the absolute latest 2026 binary (KLSX_YYYYMMDD_HHMM.gz)
        // Correcting the pattern to ensure it grabs only the live .gz files
        const filePattern = /KLSX_2026\d{4}_\d{4}\.gz/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[0]);

        if (matches.length === 0) {
            console.log("[ALERT] Sector empty. Scanning for directory updates...");
            // Debug: Log the first bit of HTML to see if the directory structure shifted
            console.log(`[DEBUG] HTML Snippet: ${html.substring(0, 300)}`);
            return;
        }

        // Grab the absolute last file (freshest data)
        const targetFile = matches.sort().pop(); 
        console.log(`[SUCCESS] Intercepted 2026 Transmission: ${targetFile}`);

        // THE RAM UPLINK: Zero-disk binary fetch
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        console.log(`[SYSTEM] Memory Load: ${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB locked in RAM.`);

        // Parse and process
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
            
            // Format for the 5-minute UI timeline
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
