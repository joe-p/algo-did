import algosdk, { ABIMethod, ABIResult } from 'algosdk';
import { ApplicationClient } from '@algorandfoundation/algokit-utils/types/app-client';
import appSpec from '../contracts/artifacts/AlgoDID.json';
import { AppCallTransactionResult } from '@algorandfoundation/algokit-utils/types/app';
import { expect } from '@jest/globals';
import { SuggestedParamsWithMinFee } from 'algosdk/dist/types/types/transactions/base';

const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 32768;

const BYTES_PER_CALL = 2048
- 4 // 4 bytes for the method selector
- 34 // 34 bytes for the key
- 8 // 8 bytes for the box index
- 8; // 8 bytes for the offset

export type Metadata = {start: bigint, end: bigint, uploading: bigint, endSize: bigint};

export async function resolveDID(did: string, algodClient: algosdk.Algodv2): Promise<Buffer> {
  const splitDid = did.split(':');

  if (splitDid[0] !== 'did') throw new Error(`Invalid protocol. Expected 'did', got ${splitDid[0]}`);
  if (splitDid[1] !== 'algo') throw new Error(`Invalid DID method. Expected 'algod', got ${splitDid[1]}`);

  const splitID = splitDid[2].split('-');

  let pubKey: Uint8Array;
  try {
    pubKey = algosdk.decodeAddress(splitID[0]).publicKey;
  } catch (e) {
    throw new Error(`Invalid public key. Expected Algorand address, got ${splitID[0]}`);
  }

  let appID: bigint;

  try {
    appID = BigInt(splitID[1]);
    algosdk.encodeUint64(appID);
  } catch (e) {
    throw new Error(`Invalid app ID. Expected uint64, got ${splitID[1]}`);
  }

  const appClient = new ApplicationClient({
    resolveBy: 'id',
    id: appID,
    sender: algosdk.generateAccount(),
    app: JSON.stringify(appSpec),
  }, algodClient);

  const boxValue = (await appClient.getBoxValueFromABIType(pubKey, algosdk.ABIType.from('(uint64,uint64,uint8,uint64)'))).valueOf() as bigint[];

  const metadata: Metadata = {
    start: boxValue[0], end: boxValue[1], uploading: boxValue[2], endSize: boxValue[3],
  };

  if (metadata.uploading) throw new Error('DID document is still being uploaded');

  const boxPromises = [];
  for (let i = metadata.start; i <= metadata.end; i += 1n) {
    boxPromises.push(appClient.getBoxValue(algosdk.encodeUint64(i)));
  }

  const boxValues = await Promise.all(boxPromises);

  return Buffer.concat(boxValues);
}

/**
 * 
 * @param algodClient 
 * @param abiMethod 
 * @param pubKey 
 * @param boxes 
 * @param boxIndex 
 * @param suggestedParams 
 * @param sender 
 * @param appID 
 * @param group 
 * @returns 
 */
export async function sendTxGroup(
    algodClient: algosdk.Algodv2,
    abiMethod: ABIMethod,
    bytesOffset: number,
    pubKey: Uint8Array, 
    boxes: algosdk.BoxReference[], 
    boxIndex: bigint,
    suggestedParams: SuggestedParamsWithMinFee,
    sender: algosdk.Account,
    appID: number,
    group: Buffer[]): Promise<string[]> {
  const firstAtc = new algosdk.AtomicTransactionComposer();
  group.forEach((chunk, i) => {
    firstAtc.addMethodCall({
      method: abiMethod!,
      methodArgs: [pubKey, boxIndex, BYTES_PER_CALL * (i + bytesOffset), chunk],
      boxes,
      suggestedParams,
      sender: sender.addr,
      signer: algosdk.makeBasicAccountTransactionSigner(sender),
      appID,
    });
  });

  await new Promise((r) => setTimeout(r, 2000));
  return (await firstAtc.execute(algodClient, 3)).txIDs
}

/**
 * 
 * @param data 
 * @param appID 
 * @param pubKey 
 * @param sender 
 * @param algodClient 
 * @returns 
 */
export async function uploadDIDDocument(
  data: Buffer,
  appID: number,
  pubKey: Uint8Array,
  sender: algosdk.Account,
  algodClient: algosdk.Algodv2,
): Promise<Metadata> {
  const appClient = new ApplicationClient({
    resolveBy: 'id',
    id: appID,
    sender,
    app: JSON.stringify(appSpec),
  }, algodClient);

  const ceilBoxes = Math.ceil(data.byteLength / MAX_BOX_SIZE);

  const endBoxSize = data.byteLength % MAX_BOX_SIZE;

  const totalCost = ceilBoxes * COST_PER_BOX // cost of data boxes
  + (ceilBoxes - 1) * MAX_BOX_SIZE * COST_PER_BYTE // cost of data
  + ceilBoxes * 8 * COST_PER_BYTE // cost of data keys
  + endBoxSize * COST_PER_BYTE // cost of last data box
  + COST_PER_BOX + (8 + 8 + 1 + 8 + 32) * COST_PER_BYTE; // cost of metadata box

  const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    from: sender.addr,
    to: (await appClient.getAppReference()).appAddress,
    amount: totalCost,
    suggestedParams: await algodClient.getTransactionParams().do(),
  });

  const appCallResult: AppCallTransactionResult = await appClient.call({
    method: 'startUpload',
    methodArgs: [pubKey, ceilBoxes, endBoxSize, mbrPayment],
    boxes: [
      pubKey,
    ],
    sendParams: { suppressLog: true },
  });
  expect(appCallResult).toBeDefined();

  const boxValue = (await appClient.getBoxValueFromABIType(pubKey, algosdk.ABIType.from('(uint64,uint64,uint8,uint64)'))).valueOf() as bigint[];

  const metadata: Metadata = {
    start: boxValue[0], end: boxValue[1], uploading: boxValue[2], endSize: boxValue[3],
  };

  const numBoxes = Math.floor(data.byteLength / MAX_BOX_SIZE);
  const boxData: Buffer[] = [];

  for (let i = 0; i < numBoxes; i += 1) {
    const box = data.subarray(i * MAX_BOX_SIZE, (i + 1) * MAX_BOX_SIZE);
    boxData.push(box);
  }

  boxData.push(data.subarray(numBoxes * MAX_BOX_SIZE, data.byteLength));

  const suggestedParams: SuggestedParamsWithMinFee = await algodClient.getTransactionParams().do();

  const boxPromises = boxData.map(async (box, boxIndexOffset) => {
    const boxIndex = metadata.start + BigInt(boxIndexOffset);
    const numChunks = Math.ceil(box.byteLength / BYTES_PER_CALL);

    const chunks: Buffer[] = [];

    for (let i = 0; i < numChunks; i += 1) {
      chunks.push(box.subarray(i * BYTES_PER_CALL, (i + 1) * BYTES_PER_CALL));
    }

    const boxRef = { appIndex: 0, name: algosdk.encodeUint64(boxIndex) };
    const boxes: algosdk.BoxReference[] = new Array(7).fill(boxRef);

    boxes.push({ appIndex: 0, name: pubKey });

    const firstGroup = chunks.slice(0, 8);
    const secondGroup = chunks.slice(8);

    await sendTxGroup(algodClient, appClient.getABIMethod('upload')!, 0, pubKey, boxes, boxIndex, suggestedParams, sender, appID, firstGroup);

    if (secondGroup.length === 0) return;

    await sendTxGroup(algodClient, appClient.getABIMethod('upload')!, 8, pubKey, boxes, boxIndex, suggestedParams, sender, appID, secondGroup);
  });

  await Promise.all(boxPromises);
  if (Buffer.concat(boxData).toString('hex') !== data.toString('hex')) throw new Error('Data validation failed!');

  await appClient.call({
    method: 'finishUpload',
    methodArgs: [pubKey],
    boxes: [
      pubKey,
    ],
    sendParams: { suppressLog: true },
  });

  return metadata;
}
