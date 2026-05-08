import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import zlib from 'zlib';

// Initialize Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING RAM-ONLY TACTICAL INTERCEPT ---");
        
        const iemBaseUrl = "https://mesonet-nexrad.agron.iastate.edu/level2/raw/KLSX/";
        const response = await fetch(iemBaseUrl);
        if (!response.ok) throw new Error(`Mirror Unavailable: ${response.status}`);
        
        const html = await response.text();
        const matches = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
        const targetFile = matches.filter(n => n.includes('KLSX') && !n.includes('?')).sort().pop();

        if (!targetFile) {
            console.log("No new telemetry detected.");
            return;
        }

        console.log(`[TARGET] Intercepting: ${targetFile}`);

        // STEP 1: Download directly to RAM
        const fileResponse = await fetch(`${iemBaseUrl}${targetFile}`);
        const arrayBuffer = await fileResponse.arrayBuffer();
        let rawBuffer = Buffer.from(arrayBuffer);

        // STEP 2: Expand binary in RAM
        if (targetFile.endsWith('.gz')) {
            rawBuffer = zlib.gunzipSync(rawBuffer);
            console.log(`[SYSTEM] Binary expanded in RAM.`);
        }

        // STEP 3: Parse and Classify
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        let type = "";
                        // Classification Tiers
                        if (dbz >= 50) type = "HAIL";
                        else if (dbz >= 35) type = "HEAVY_RAIN";
                        else if (dbz >= 20) type = "LIGHT_RAIN";
                        else if (dbz >= 5) type = "CLOUDS";

                        if (type !== "") {
                            stormPoints.push({ a: msg.record.azimuth, g: i, v: Math.round(dbz), t: type });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            // Sort by intensity so dangerous weather fills the 1000-point payload first
            const payload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            
            // Step 4: Logic for 10-minute floor snapping
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
            const snappedMin = Math.floor(parseInt(tz.minute) / 10) * 10;
            const mm = String(snappedMin).padStart(2, '0');

            const docName = `STORM_${tz.year}-${tz.month}-${tz.day}_${hh}${mm}`;
            console.log(`[UPLINK] Deploying to Cabinet: radar_archive/${docName}`);

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now(),
                sensor: "KLSX",
                source: `IEM_NEXRAD://${targetFile}`
            });

            console.log(`[LOCKED] Deployment Confirmed via RAM.`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error.message);
    }
}

executeTacticalSweep();
