import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import { execSync } from 'child_process';

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING ZERO-DISK STREAM INTERCEPT ---");
        
        const now = new Date();
        const pathPrefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}/KLSX/`;

        // 1. Get the latest filename using the CLI
        const listCmd = `aws s3 ls s3://noaa-nexrad-level2/${pathPrefix} --no-sign-request`;
        const listOutput = execSync(listCmd).toString();
        const targetFile = listOutput.trim().split('\n').map(l => l.split(/\s+/).pop()).filter(f => f.endsWith('V06')).pop();

        if (!targetFile) return console.log("Sector Empty.");

        // 2. THE PIPE: Download directly into a Buffer (RAM) - NEVER touches the disk
        console.log(`[SYSTEM] Streaming ${targetFile} directly to RAM...`);
        const s3Path = `s3://noaa-nexrad-level2/${pathPrefix}${targetFile}`;
        const rawBuffer = execSync(`aws s3 cp ${s3Path} - --no-sign-request`); 

        // 3. Parse and Deploy
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            sweep?.forEach((msg) => {
                const dbzData = msg.record?.reflect?.moment_data;
                if (dbzData) {
                    dbzData.forEach((dbz, i) => {
                        if (dbz >= 18) stormPoints.push({ a: msg.record.azimuth, g: i, v: Math.round(dbz) });
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const payload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            const docName = `STORM_${targetFile}`;
            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(payload),
                timestamp: Date.now()
            });
            console.log(`[SUCCESS] RAM-Stream Complete: ${docName}`);
        }
    } catch (e) { console.error("STREAM FAILURE:", e.message); }
}
executeTacticalSweep();
