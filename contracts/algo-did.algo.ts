// eslint-disable-next-line import/no-extraneous-dependencies
import { Contract } from '@algorandfoundation/tealscript';

/*
start - The index of the box at which the data starts
end - The index of the box at which the data ends
uploading - true if the data is still being uploaded
endSize - The size of the last box
*/
type Metadata = {start: uint64, end: uint64, uploading: uint<8>, endSize: uint64};

const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 32768;

// eslint-disable-next-line no-unused-vars
class AlgoDID extends Contract {
  // The boxes that contain the data, indexed by uint64
  dataBoxes = new BoxMap<uint64, bytes>();

  // Metadata for a given address
  metadata = new BoxMap<Address, Metadata>();

  // The index of the next box to be created
  currentIndex = new GlobalStateKey<uint64>();

  /**
   *
   * Allocate boxes to begin data upload process
   *
   * @param address The address of the DID
   * @param numBoxes The number of boxes that the data will take up
   * @param endBoxSize The size of the last box
   * @param mbrPayment Payment from the uploader to cover the box MBR
   */
  startUpload(
    address: Address,
    numBoxes: uint64,
    endBoxSize: uint64,
    mbrPayment: PayTxn,
  ): void {
    const startBox = this.currentIndex.get();
    const endBox = startBox + numBoxes - 1;

    const metadata: Metadata = {
      start: startBox, end: endBox, uploading: 1, endSize: endBoxSize,
    };

    assert(!this.metadata.exists(address));

    this.metadata.set(address, metadata);

    this.currentIndex.set(endBox + 1);

    const totalCost = numBoxes * COST_PER_BOX // cost of boxes
    + (numBoxes - 1) * MAX_BOX_SIZE * COST_PER_BYTE // cost of data
    + numBoxes * 64 * COST_PER_BYTE // cost of keys
    + endBoxSize * COST_PER_BYTE; // cost of last box data

    assert(mbrPayment.amount === totalCost);
    assert(mbrPayment.receiver === this.app.address);
  }

  /**
   *
   * Upload data to a specific offset in a box
   *
   * @param address The address of the DID
   * @param boxIndex The index of the box to upload the given chunk of data to
   * @param offset The offset within the box to start writing the data
   * @param data The data to write
   */
  upload(address: Address, boxIndex: uint64, offset: uint64, data: bytes): void {
    const metadata = this.metadata.get(address);
    assert(metadata.uploading === <uint<8>>1);
    assert(metadata.start <= boxIndex && boxIndex <= metadata.end);

    if (offset === 0) {
      this.dataBoxes.create(boxIndex, boxIndex === metadata.end ? metadata.endSize : MAX_BOX_SIZE);
    }

    this.dataBoxes.replace(boxIndex, offset, data);
  }

  /**
   *
   * Mark uploading as false
   *
   * @param address The address of the DID
   */
  finishUpload(address: Address): void {
    this.metadata.get(address).uploading = 0;
  }
}
