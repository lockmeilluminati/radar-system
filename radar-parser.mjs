import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 DIAGNOSTIC INTERCEPT ---");
        
        const iemBaseUrl = "https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/";
        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Mirror Unavailable: ${response.status}`);
        
        const html = await response.text();
        const filePattern = /href="([^"]+)"/g;
        const matches = [...html.matchAll(filePattern)].map(m => m[1]);
        
        const validFiles = matches.filter(name => 
            name.includes('KLSX') && !name.includes('?C=') && !name.includes('/')
        );

        if (validFiles.length === 0) return;

        const targetFile = validFiles.sort().pop(); 
        console.log(`[TARGET] Found Newest Transmission: ${targetFile}`);

        // --- STEP 1: PHYSICAL DOWNLOAD & DISK VERIFICATION ---
        const downloadUrl = `${iemBaseUrl}${targetFile}`;
        const fileResponse = await fetch(downloadUrl);
        const arrayBuffer = await fileResponse.arrayBuffer();
        let rawBuffer = Buffer.from(arrayBuffer);

        const localPath = path.join('/tmp', targetFile);
        fs.writeFileSync(localPath, rawBuffer);
        const stats = fs.statSync(localPath);
        console.log(`[SUCCESS] File Downloaded: ${localPath} (${stats.size} bytes)`);

        // --- STEP 2: DECOMPRESSION ---
        if (targetFile.endsWith('.gz')) {
            rawBuffer = zlib.gunzipSync(rawBuffer);
            console.log(`[SYSTEM] Decompressed .gz binary in RAM.`);
        }

        // --- STEP 3: FULL EXTRACTION TELEMETRY (CLOSED-LOOP) ---
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        console.log(`[DECODER] Binary Scanned: ${sweeps.length} Sweeps detected.`);

        let totalRawPoints = 0;
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const az = msg.record.azimuth;
                const dbzData = msg.record?.reflect?.moment_data;
                const velData = msg.record?.velocity?.moment_data;

                // Process Reflectivity (v) -> Used for Radar, Storms, and Hail
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        totalRawPoints++;
                        if (dbz >= 18) {
                            stormPoints.push({ a: az, g: i, v: Math.round(dbz) });
                        }
                    });
                }

                // Process Doppler Velocity (w) -> Used for Wind Engine
                if (velData) {
                    velData.forEach((vel, i) => {
                        totalRawPoints++;
                        // Filter out stagnant air (near 0 m/s) to save payload space
                        if (Math.abs(vel) >= 5) { 
                            stormPoints.push({ a: az, g: i, w: Math.round(vel) });
                        }
                    });
                }
            });
        });

        console.log(`[TELEMETRY] Total Points Processed: ${totalRawPoints}`);
        console.log(`[TELEMETRY] Usable Tactical Points Extracted: ${stormPoints.length}`);

        if (stormPoints.length > 0) {
            // Sort by absolute intensity (dBZ or Wind Speed) and bump slice to 1500 for the dual-data
            const payload = stormPoints
                .sort((a, b) => (b.v || Math.abs(b.w)) - (a.v || Math.abs(a.w)))
                .slice(0, 1500);
            
            // --- STEP 4: 5-MINUTE MICRO-LOCK (St. Louis Time) ---
            const parts = targetFile.replace('.gz', '').split('_');
            const radarDate = new Date(Date.UTC(
                parseInt(parts[1].substring(0, 4)),
                parseInt(parts[1].substring(4, 6)) - 1,
                parseInt(parts[1].substring(6, 8)),
                parseInt(parts[2].substring(0, 2)),
                parseInt(parts[2].substring(2, 4))
            ));
            
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/Chicago',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            
            const tz = formatter.formatToParts(radarDate).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
            
            const hh = tz.hour === '24' ? '00' : tz.hour;
            
            const exactMin = parseInt(tz.minute);
            const snappedMin = Math.floor(exactMin / 5) * 5;
            const mm = String(snappedMin).padStart(2, '0');

            const docName = `STORM_${tz.year}-${tz.month}-${tz.day}_${hh}${mm}`;
            console.log(`[UPLINK] Deploying to Cabinet: radar_archive/${docName}`);

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `IEM_NEXRAD://${targetFile}`
            });

            console.log(`[LOCKED] Deployment Confirmed. Document is LIVE.`);
        } else {
            console.log("[ALERT] Extraction complete but 0 significant storm points found.");
        }

        // --- STEP 5: TACTICAL CLEANUP ---
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
            console.log(`[SYSTEM] Cleared temporary asset from memory: ${localPath}`);
        }

    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
    }
}

executeTacticalSweep();
