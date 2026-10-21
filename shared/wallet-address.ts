import { ethers } from 'ethers';

export const EVM_WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
export const WRFCOIN_NATIVE_ADDRESS_REGEX = /^(wrf|WRF)[a-fA-F0-9]{40}$/;

export function isEvmWalletAddress(address: string): boolean {
  return EVM_WALLET_ADDRESS_REGEX.test(address);
}

export function isNativeWrfcoinAddress(address: string): boolean {
  return WRFCOIN_NATIVE_ADDRESS_REGEX.test(address);
}

export function isValidWrfcoinAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  if (isNativeWrfcoinAddress(address)) {
    return true;
  }

  if (!isEvmWalletAddress(address)) {
    return false;
  }

  return ethers.isAddress(address.toLowerCase());
}

export function normalizeWalletAddress(address: string): string {
  return address.trim().toLowerCase();
}
