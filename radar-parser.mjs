import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Level2Radar } from 'nexrad-level-2-data';

// 1. Initialize Firebase using the GitHub Secret
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

// 2. Configure S3 Client for TRULY Anonymous Access
// By omitting credentials and setting the signer to a no-op, 
// we bypass the "InvalidAccessKeyId" error and the "403 Forbidden".
const s3Client = new S3Client({
    region: "us-east-1",
    signer: { sign: async (request) => request } 
});

async function executeTacticalSweep() {
    try {
        console.log("--- INITIATING 2026 SDK INTERCEPT ---");
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        const prefix = `${year}/${month}/${day}/KLSX/`;

        console.log(`[SYSTEM] Accessing NOAA Sector: ${prefix} (UTC)`);

        // 3. Use the SDK to list objects anonymously
        const listCommand = new ListObjectsV2Command({
            Bucket: "noaa-nexrad-level2",
            Prefix: prefix
        });

        const listOutput = await s3Client.send(listCommand);
        
        if (!listOutput.Contents || listOutput.Contents.length === 0) {
            console.log("[ALERT] Sector empty. No 2026 data found in this window.");
            return;
        }

        // Filter for valid radar binaries (V06) and sort for the latest
        const validScans = listOutput.Contents
            .filter(item => item.Key.endsWith('V06') && !item.Key.endsWith('_MDM'))
            .sort((a, b) => b.LastModified - a.LastModified);

        if (validScans.length === 0) {
            console.log("[ALERT] No valid binaries found in this sector.");
            return;
        }

        const targetScanKey = validScans[0].Key;
        console.log(`[SUCCESS] Intercepted latest 2026 transmission: ${targetScanKey}`);

        // 4. Download directly to RAM using the SDK
        const getCommand = new GetObjectCommand({
            Bucket: "noaa-nexrad-level2",
            Key: targetScanKey
        });

        const response = await s3Client.send(getCommand);
        const rawBuffer = Buffer.from(await response.Body.transformToByteArray());

        console.log(`[SYSTEM] Memory Load: ${(rawBuffer.length / (1024 * 1024)).toFixed(2)} MB locked in RAM.`);

        // 5. Parse using the local nexrad dependency
        const radar = await new Level2Radar(rawBuffer);
        const sweeps = radar.data || [];
        let stormPoints = [];

        sweeps.forEach((sweep) => {
            if (!sweep) return;
            sweep.forEach((radialMsg) => {
                const record = radialMsg.record;
                if (record.reflect && record.reflect.moment_data) {
                    record.reflect.moment_data.forEach((dbz, gateIndex) => {
                        // Extracting significant atmospheric points
                        if (dbz !== null && dbz >= 18) {
                            stormPoints.push({ a: record.azimuth, g: gateIndex, v: Math.round(dbz) });
                        }
                    });
                }
            });
        });

        if (stormPoints.length > 0) {
            const tacticalPayload = stormPoints.sort((a, b) => b.v - a.v).slice(0, 1000);
            
            // Sync with your 5-minute database requirement
            const localNow = new Date();
            const mins = Math.floor(localNow.getMinutes() / 5) * 5;
            const docName = `STORM_${year}-${month}-${day}_${String(localNow.getHours()).padStart(2, '0')}${String(mins).padStart(2, '0')}`;

            await db.collection("radar_archive").doc(docName).set({
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now(),
                sensor: "KLSX",
                source: targetScanKey
            });

            console.log(`[SUCCESS] Data locked in Cabinet -> ${docName}`);
        }
    } catch (error) {
        console.error("MISSION CRITICAL FAILURE:", error);
    }
}

executeTacticalSweep();
