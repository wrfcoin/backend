import { ethers } from 'ethers';

export const WEATHER_SELECTOR = ethers.id('executeWeatherSubmission(bytes)').slice(0, 10);

export async function buildPaymasterAndData(userOp: {
  sender: string;
  nonce: string | number;
  callData: string;
}): Promise<{ paymasterAndData: string; deadline: number; weatherDataHash: string; oracle: string }> {
  const signerKey = process.env.SPONSOR_ORACLE_PRIVATE_KEY || process.env.SPONSOR_PRIVATE_KEY;
  if (!signerKey) {
    throw new Error('SPONSOR_ORACLE_PRIVATE_KEY or SPONSOR_PRIVATE_KEY is required');
  }
  const paymasterAddress = process.env.PAYMASTER_ADDRESS;
  if (!paymasterAddress || !/^0x[a-fA-F0-9]{40}$/.test(paymasterAddress)) {
    throw new Error('PAYMASTER_ADDRESS must be a valid EVM address');
  }

  if (!userOp.callData || !userOp.callData.startsWith(WEATHER_SELECTOR)) {
    throw new Error('userOp.callData selector mismatch');
  }

  const signer = new ethers.Wallet(signerKey);
  const oracleAddress = signer.address;
  const deadline = Math.floor(Date.now() / 1000) + Number(process.env.SPONSOR_VALIDITY_SECONDS || 120);

  const encodedArgs = `0x${userOp.callData.slice(10)}`;
  let weatherPacket: string;
  try {
    // executeWeatherSubmission(bytes packetData)
    weatherPacket = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], encodedArgs)[0] as string;
  } catch {
    weatherPacket = '0x';
  }
  const weatherDataHash = ethers.keccak256(weatherPacket);
  const callDataHash = ethers.keccak256(userOp.callData);
  const chainId = BigInt(process.env.PAYMASTER_CHAIN_ID || 31337);

  const sponsorshipDigest = ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint48'],
    [
      chainId,
      paymasterAddress,
      userOp.sender,
      callDataHash,
      weatherDataHash,
      deadline,
    ]
  );

  // signMessage adds Ethereum signed message prefix, matching MessageHashUtils in solidity
  const signature = await signer.signMessage(ethers.getBytes(sponsorshipDigest));
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32', 'uint48', 'bytes'],
    [oracleAddress, weatherDataHash, deadline, signature]
  );

  const paymasterAndData = `${paymasterAddress}${encoded.slice(2)}`;
  return {
    paymasterAndData,
    deadline,
    weatherDataHash,
    oracle: oracleAddress,
  };
}
