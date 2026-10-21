/**
 * EIP-712 Implementation for Wrfcoin
 *
 * This module provides utilities for implementing EIP-712 typed data signing and verification.
 * EIP-712 enables secure, human-readable message signing, which is particularly useful for
 * cross-chain transactions, NFT operations, and governance actions.
 *
 * References:
 * - https://eips.ethereum.org/EIPS/eip-712
 */

const ethUtil = require('ethereumjs-util');
const ethAbi = require('ethereumjs-abi');

/**
 * Domain separator is a unique identifier for the application to prevent
 * signature reuse across different applications
 */
function getDomainSeparator(name, version, chainId, verifyingContract) {
  return ethUtil.keccak256(
    ethAbi.rawEncode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        ethUtil.keccak256(
          Buffer.from(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
          )
        ),
        ethUtil.keccak256(Buffer.from(name)),
        ethUtil.keccak256(Buffer.from(version)),
        chainId,
        verifyingContract,
      ]
    )
  );
}

/**
 * Create a hash of the type specifications, used for the final encoding
 */
function getTypeHash(typeName, types) {
  const typeStr = types[typeName]
    .reduce((accum, { name, type }) => {
      return accum + `${type} ${name},`;
    }, '')
    .slice(0, -1);

  return ethUtil.keccak256(Buffer.from(`${typeName}(${typeStr})`));
}

/**
 * Encode a data structure according to the EIP-712 specification
 * @param {string} typeName - Name of the type being encoded
 * @param {Object} types - Type definitions
 * @param {Object} data - Data to encode
 * @returns {Buffer} - Encoded data
 */
function encodeData(typeName, types, data) {
  const encTypes = [];
  const encValues = [];

  // Add typeHash
  encTypes.push('bytes32');
  encValues.push(getTypeHash(typeName, types));

  // Add field contents
  for (const field of types[typeName]) {
    const value = data[field.name];

    if (field.type === 'string' || field.type === 'bytes') {
      encTypes.push('bytes32');
      const hashValue = ethUtil.keccak256(Buffer.from(value));
      encValues.push(hashValue);
    } else if (types[field.type]) {
      encTypes.push('bytes32');
      const hashValue = ethUtil.keccak256(encodeData(field.type, types, value));
      encValues.push(hashValue);
    } else if (field.type.lastIndexOf(']') === field.type.length - 1) {
      throw new Error('Arrays currently not supported in EIP-712');
    } else {
      encTypes.push(field.type);
      encValues.push(value);
    }
  }

  return ethAbi.rawEncode(encTypes, encValues);
}

/**
 * Create a hash of structured data according to EIP-712
 * @param {Object} typedData - The typed data object
 * @returns {Buffer} - The hash of the typed data
 */
function hashTypedData(typedData) {
  const domainSeparator = getDomainSeparator(
    typedData.domain.name,
    typedData.domain.version,
    typedData.domain.chainId,
    typedData.domain.verifyingContract
  );

  const dataHash = ethUtil.keccak256(
    encodeData(typedData.primaryType, typedData.types, typedData.message)
  );

  return ethUtil.keccak256(
    Buffer.concat([Buffer.from('1901', 'hex'), domainSeparator, dataHash])
  );
}

/**
 * Convenience function for creating a cross-chain transaction
 * typed data object compatible with EIP-712
 */
function createCrossChainTransaction(
  fromChain,
  toChain,
  fromAddress,
  toAddress,
  tokenAddress,
  amount,
  nonce,
  deadline,
  chainId,
  contractAddress
) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      CrossChainTransfer: [
        { name: 'fromChain', type: 'string' },
        { name: 'toChain', type: 'string' },
        { name: 'fromAddress', type: 'address' },
        { name: 'toAddress', type: 'address' },
        { name: 'tokenAddress', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'CrossChainTransfer',
    domain: {
      name: 'Wrfcoin Bridge',
      version: '1',
      chainId: chainId,
      verifyingContract: contractAddress,
    },
    message: {
      fromChain,
      toChain,
      fromAddress,
      toAddress,
      tokenAddress,
      amount,
      nonce,
      deadline,
    },
  };
}

/**
 * Convenience function for creating a governance action
 * typed data object compatible with EIP-712
 */
function createGovernanceAction(
  proposalId,
  support,
  voter,
  nonce,
  deadline,
  chainId,
  contractAddress
) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      GovernanceVote: [
        { name: 'proposalId', type: 'uint256' },
        { name: 'support', type: 'bool' },
        { name: 'voter', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'GovernanceVote',
    domain: {
      name: 'Wrfcoin Governance',
      version: '1',
      chainId: chainId,
      verifyingContract: contractAddress,
    },
    message: {
      proposalId,
      support,
      voter,
      nonce,
      deadline,
    },
  };
}

/**
 * Convenience function for creating an NFT minting action
 * typed data object compatible with EIP-712
 */
function createNftMintAction(
  creator,
  recipient,
  tokenId,
  tokenUri,
  royaltyBps,
  metadataHash,
  nonce,
  deadline,
  chainId,
  contractAddress
) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      NFTMint: [
        { name: 'creator', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'tokenUri', type: 'string' },
        { name: 'royaltyBps', type: 'uint256' },
        { name: 'metadataHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'NFTMint',
    domain: {
      name: 'Wrfcoin NFT',
      version: '1',
      chainId: chainId,
      verifyingContract: contractAddress,
    },
    message: {
      creator,
      recipient,
      tokenId,
      tokenUri,
      royaltyBps,
      metadataHash,
      nonce,
      deadline,
    },
  };
}

/**
 * Verify an EIP-712 signature
 * @param {Object} typedData - The typed data object
 * @param {string} signature - Hex string of the signature
 * @param {string} expectedSigner - Expected signer address
 * @returns {boolean} - Whether the signature is valid
 */
function verifyTypedDataSignature(typedData, signature, expectedSigner) {
  const sigBuffer = ethUtil.toBuffer(signature);
  const r = sigBuffer.slice(0, 32);
  const s = sigBuffer.slice(32, 64);
  const v = sigBuffer[64];

  const messageHash = hashTypedData(typedData);
  const publicKey = ethUtil.ecrecover(messageHash, v, r, s);
  const addressBuffer = ethUtil.publicToAddress(publicKey);
  const address = ethUtil.bufferToHex(addressBuffer);

  return address.toLowerCase() === expectedSigner.toLowerCase();
}

module.exports = {
  hashTypedData,
  createCrossChainTransaction,
  createGovernanceAction,
  createNftMintAction,
  verifyTypedDataSignature,
};
