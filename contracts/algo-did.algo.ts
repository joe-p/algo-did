// eslint-disable-next-line import/no-extraneous-dependencies
import { Contract } from '@algorandfoundation/tealscript';

const UPLOADING: uint<8> = 0;
const READY: uint<8> = 1;
const DELETING: uint<8> = 2;

/*
start - The index of the box at which the data starts
end - The index of the box at which the data ends
status - 0 if uploading, 1 if ready, 2 if deleting
endSize - The size of the last box
*/
type Metadata = {start: uint64, end: uint64, status: uint<8>, endSize: uint64, lastDeleted: uint64};

const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 32768;

// eslint-disable-next-line no-unused-vars
class AlgoDID extends Contract {
  // The boxes that contain the data, indexed by uint64
  dataBoxes = BoxMap<uint64, bytes>();

  // Metadata for a given pubkey
  metadata = BoxMap<Address, Metadata>();

  // The index of the next box to be created
  currentIndex = GlobalStateKey<uint64>();

  createApplication(): void {
    this.currentIndex.value = 1;
  }

  /**
   *
   * Allocate boxes to begin data upload process
   *
   * @param pubKey The pubkey of the DID
   * @param numBoxes The number of boxes that the data will take up
   * @param endBoxSize The size of the last box
   * @param mbrPayment Payment from the uploader to cover the box MBR
   */
  startUpload(
    pubKey: Address,
    numBoxes: uint64,
    endBoxSize: uint64,
    mbrPayment: PayTxn,
  ): void {
    assert(this.txn.sender === globals.creatorAddress);

    const startBox = this.currentIndex.value;
    const endBox = startBox + numBoxes - 1;

    const metadata: Metadata = {
      start: startBox, end: endBox, status: UPLOADING, endSize: endBoxSize, lastDeleted: 0,
    };

    assert(!this.metadata(pubKey).exists);

    this.metadata(pubKey).value = metadata;

    this.currentIndex.value = endBox + 1;

    const totalCost = numBoxes * COST_PER_BOX // cost of data boxes
    + (numBoxes - 1) * MAX_BOX_SIZE * COST_PER_BYTE // cost of data
    + numBoxes * 8 * COST_PER_BYTE // cost of data keys
    + endBoxSize * COST_PER_BYTE // cost of last data box
    + COST_PER_BOX + (8 + 8 + 1 + 8 + 32 + 8) * COST_PER_BYTE; // cost of metadata box

    assert(mbrPayment.amount === totalCost);
    assert(mbrPayment.receiver === this.app.address);
  }

  /**
   *
   * Upload data to a specific offset in a box
   *
   * @param pubKey The pubkey of the DID
   * @param boxIndex The index of the box to upload the given chunk of data to
   * @param offset The offset within the box to start writing the data
   * @param data The data to write
   */
  upload(pubKey: Address, boxIndex: uint64, offset: uint64, data: bytes): void {
    assert(this.txn.sender === globals.creatorAddress);

    const metadata = this.metadata(pubKey).value;
    assert(metadata.status === UPLOADING);
    assert(metadata.start <= boxIndex && boxIndex <= metadata.end);

    if (offset === 0) {
      this.dataBoxes(boxIndex).create(boxIndex === metadata.end ? metadata.endSize : MAX_BOX_SIZE);
    }

    this.dataBoxes(boxIndex).replace(offset, data);
  }

  /**
   *
   * Mark uploading as false
   *
   * @param pubKey The address of the DID
   */
  finishUpload(pubKey: Address): void {
    assert(this.txn.sender === globals.creatorAddress);

    this.metadata(pubKey).value.status = READY;
  }

  /**
   * Starts the deletion process for the data associated with a DID
   *
   * @param pubKey The address of the DID
   */
  startDelete(pubKey: Address): void {
    assert(this.txn.sender === globals.creatorAddress);

    const metadata = this.metadata(pubKey).value;
    assert(metadata.status === READY);

    metadata.status = DELETING;
  }

  /**
   * Deletes a box of data
   *
   * @param pubKey The address of the DID
   * @param boxIndex The index of the box to delete
   */
  deleteData(pubKey: Address, boxIndex: uint64): void {
    assert(this.txn.sender === globals.creatorAddress);

    const metadata = this.metadata(pubKey).value;
    assert(metadata.status === DELETING);
    assert(metadata.start <= boxIndex && boxIndex <= metadata.end);

    // TODO: debug this
    // if (boxIndex !== metadata.start) assert(metadata.lastDeleted === boxIndex - 1);

    const preMBR = globals.currentApplicationAddress.minBalance;

    this.dataBoxes(boxIndex).delete();

    if (boxIndex === metadata.end) this.metadata(pubKey).delete();
    else metadata.lastDeleted = boxIndex;

    sendPayment({
      fee: 0,
      amount: preMBR - globals.currentApplicationAddress.minBalance,
      receiver: this.txn.sender,
    });
  }

  /**
   * Dummy function to add extra box references for deleteData
   */
  dummy(): void {}

  /**
   * Allow the contract to be updated by the creator
   */
  updateApplication(): void {
    assert(globals.creatorAddress === this.txn.sender);
  }
}
