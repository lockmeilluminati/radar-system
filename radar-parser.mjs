import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import fs from 'fs';

// --- TACTICAL SECRETS DECODING ---
// This allows GitHub Actions to use your key without it being in the code
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

const app = initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore(app);

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 5-MINUTE AUTO-SWEEP ---");
        
        // This binary needs to be in your repository for the first run
        const rawData = fs.readFileSync("./KLSX20260506_051438_V06");
        const radar = await new Level2Radar(rawData);
        const sweeps = radar.data || [];

        let stormPoints = [];
        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                const az = record.azimuth;
                const reflect = record.reflect;
                if (reflect && reflect.moment_data) {
                    reflect.moment_data.forEach((dbz, gateIndex) => {
                        if (dbz !== null && dbz >= 15) { 
                            stormPoints.push({ a: az, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);

            // 5-Minute Precision Logic
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const mins = Math.floor(now.getMinutes() / 5) * 5;
            
            const archiveDate = `${year}-${month}-${day}`; 
            const archiveTime = String(now.getHours()).padStart(2, '0') + String(mins).padStart(2, '0');
            const documentName = `STORM_${archiveDate}_${archiveTime}`;

            await db.collection("radar_archive").doc(documentName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX"
            });

            console.log(`[SUCCESS] 11:00 Sector Secured: ${documentName}`);
        }
    } catch (error) {
        console.error("SWEEP FAILED:", error);
        process.exit(1);
    }
}
executeTacticalSweep();
