import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';

// --- CABINET AUTHENTICATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 IEM ACADEMIC INTERCEPT ---");
        
        // Target the IEM Professional Mirror for St. Louis
        const iemBaseUrl = "https://mesonet.agron.iastate.edu/data/nexrd2/raw/KLSX/";
        console.log(`[SYSTEM] Scanning University Gateway: ${iemBaseUrl}`);

        // 1. Fetch the directory listing (HTML)
        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`IEM Mirror Offline: ${response.status}`);
        const html = await response.text();
        
        // 2. Extract the absolute latest 2026 binary using Regex
        // Format: KLSX_YYYYMMDD_HHMM.gz
        const filePattern = /KLSX_2026\d{4}_\d{4}\.gz/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[0]);

        if (matches.length === 0) {
            console.log("[ALERT] Sector empty on IEM Mirror. Sync in progress.");
            return;
        }

        // Grab the absolute last file in the list (most recent)
        const targetFile = matches.sort().pop(); 
        console.log(`[SUCCESS] Intercepted 2026 Transmission: ${targetFile}`);

        // 3. THE RAM UPLINK: Zero-disk binary fetch
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

        console.log(`[SYSTEM] Memory Load: ${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB locked in RAM.`);

        // 4. Parse the radar binary
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        // Intensity filter for atmospheric data
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
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            
            // Format for the 5-minute UI timeline
            const now = new Date();
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            const docName = `STORM_2026-05-06_${String(now.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `IEM://${targetFile}`
            });

            console.log(`[LOCKED] 2026 Data Deployed to Cabinet: ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
        process.exit(1);
    }
}

executeTacticalSweep();
