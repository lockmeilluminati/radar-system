import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { Level2Radar } from 'nexrad-level-2-data';
import fs from 'fs';

// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyCLpBKVtRzf-uuM4r-w5AFcm-i2XrSiVPk",
    authDomain: "radar-5e4a5.firebaseapp.com",
    projectId: "radar-5e4a5",
    storageBucket: "radar-5e4a5.firebasestorage.app",
    messagingSenderId: "230281188214",
    appId: "1:230281188214:web:9a2bcadae56281749b6057"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function tacticalUplink() {
    try {
        console.log("--- INITIATING SECTION 9 UPLINK ---");
        const rawData = fs.readFileSync("./KLSX20260506_051438_V06");
        const radar = await new Level2Radar(rawData);
        const sweeps = radar.data || [];

        let stormPoints = [];

        sweeps.forEach((sweep, sIdx) => {
            if (!sweep) return;
            sweep.forEach((radialMsg, rIdx) => {
                const record = radialMsg.record;
                const az = record.azimuth;
                const reflect = record.reflect;

                if (reflect && reflect.moment_data) {
                    const data = reflect.moment_data;
                    
                    // Verbose Logging for first 3 radials of Sweep 0
                    if (sIdx === 0 && rIdx < 3) {
                        console.log(`\n[RADIAL ${rIdx}] AZIMUTH LOCKED: ${az.toFixed(2)}°`);
                        console.log(` > GATES: ${reflect.gate_count} | SAMPLES: [${data.slice(0, 5).join(', ')}]`);
                    }

                    data.forEach((dbz, gateIndex) => {
                        // Filter: 15dBZ threshold to catch the core
                        if (dbz !== null && dbz >= 15) {
                            stormPoints.push({
                                a: az,
                                g: gateIndex,
                                v: Math.round(dbz)
                            });
                        }
                    });
                }
            });
        });

        console.log(`\n--- TACTICAL ANALYSIS COMPLETE ---`);
        console.log(`Total Significant Points Found: ${stormPoints.length}`);

        if (stormPoints.length > 0) {
            // Sort by intensity and slice to 1000 to protect the Cabinet
            const tacticalPayload = stormPoints
                .sort((a, b) => b.v - a.v)
                .slice(0, 1000);

            // 1. UPLINK STORM ARRAY
            await setDoc(doc(db, "radar_live", "STORM_DATA"), {
                points: JSON.stringify(tacticalPayload),
                count: tacticalPayload.length,
                timestamp: Date.now()
            });

            // 2. UPLINK SENSOR STATUS
            await setDoc(doc(db, "radar_live", "KLSX"), {
                station: "KLSX (St. Louis)",
                status: "Online",
                vcp: radar.vcp?.pattern_number || 215,
                last_updated: new Date().toISOString()
            });

            console.log("SUCCESS: 1000 Points Uplinked to Cabinet.");
        }

    } catch (error) {
        console.error("UPLINK FAILED:", error.stack);
    }
}

tacticalUplink();
