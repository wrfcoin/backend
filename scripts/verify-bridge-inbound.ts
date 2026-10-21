import { EvmAdapter } from '../server/wormhole/evm-adapter.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function verifyBridge() {
    const rpcUrl = process.env.WORMHOLE_EVM_RPC_URL;
    // 2026 Sepolia Testnet Addresses
    const coreBridgeAddress = '0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78';
    const tokenBridgeAddress = '0x7b18698094851df265Bf9e4605A1A2035c694eb4';

    if (!rpcUrl) {
        console.error("WORMHOLE_EVM_RPC_URL not set in .env");
        process.exit(1);
    }

    console.log(`Connecting to EVM RPC: ${rpcUrl}`);
    const adapter = new EvmAdapter(rpcUrl, coreBridgeAddress, tokenBridgeAddress);

    try {
        console.log("Fetching message fee from Wormhole Core Bridge...");
        const fee = await adapter.getMessageFee();
        console.log(`Success! Current message fee: ${fee.toString()} wei`);
        
        console.log("\nBridge Configuration Verified:");
        console.log(`- Core Bridge: ${coreBridgeAddress}`);
        console.log(`- Token Bridge: ${tokenBridgeAddress}`);
        console.log("- Status: CONNECTED");
    } catch (error) {
        console.error("Failed to connect to bridge:", error.message);
        process.exit(1);
    }
}

verifyBridge().catch(console.error);
