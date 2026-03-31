import {
    CCID_HEADER_SIZE,
    PC_TO_RDR_ICCPOWERON,
    PC_TO_RDR_ICCPOWEROFF,
    PC_TO_RDR_GETSLOTSTATUS,
    PC_TO_RDR_XFRBLOCK,
    CMD_STATUS_SUCCESS,
    ICC_STATUS_NOT_PRESENT,
    EP_BULK_OUT,
    EP_BULK_IN
} from './types.ts'
import type {UsbDevice} from './usb.ts'

export interface CcidResponse {
    messageType: number
    slot: number
    seq: number
    status: number
    error: number
    data: Buffer
    iccStatus: number
    cmdStatus: number
}

export class CcidTransport {
    private seq = 0
    private usb: UsbDevice

    constructor(usb: UsbDevice) {
        this.usb = usb
    }

    private nextSeq(): number {
        const s = this.seq
        this.seq = (this.seq + 1) & 0xff
        return s
    }

    private buildHeader(
        msgType: number,
        dataLength: number,
        slot: number,
        seq: number,
        param0: number,
        param1: number,
        param2: number
    ): Buffer {
        const header = Buffer.alloc(CCID_HEADER_SIZE)
        header[0] = msgType
        header.writeUInt32LE(dataLength, 1)
        header[5] = slot
        header[6] = seq
        header[7] = param0
        header[8] = param1
        header[9] = param2
        return header
    }

    private parseResponse(raw: Buffer): CcidResponse {
        if (raw.length < CCID_HEADER_SIZE) {
            throw new Error(`CCID response too short: ${raw.length} bytes`)
        }

        const messageType = raw[0]!
        const dataLength = raw.readUInt32LE(1)
        const slot = raw[5]!
        const seq = raw[6]!
        const status = raw[7]!
        const error = raw[8]!
        const data = raw.subarray(CCID_HEADER_SIZE, CCID_HEADER_SIZE + dataLength)

        return {
            messageType,
            slot,
            seq,
            status,
            error,
            data,
            iccStatus: status & 0x03,
            cmdStatus: status & 0xc0
        }
    }

    private sendAndReceive(msg: Buffer, timeout?: number): CcidResponse {
        this.usb.bulkWrite(EP_BULK_OUT, msg, timeout)
        const response = this.usb.bulkRead(EP_BULK_IN, 256, timeout)
        return this.parseResponse(response)
    }

    powerOn(): CcidResponse {
        const seq = this.nextSeq()
        const header = this.buildHeader(PC_TO_RDR_ICCPOWERON, 0, 0, seq, 0x00, 0x00, 0x00)
        return this.sendAndReceive(header)
    }

    powerOff(): CcidResponse {
        const seq = this.nextSeq()
        const header = this.buildHeader(PC_TO_RDR_ICCPOWEROFF, 0, 0, seq, 0x00, 0x00, 0x00)
        return this.sendAndReceive(header)
    }

    getSlotStatus(): CcidResponse {
        const seq = this.nextSeq()
        const header = this.buildHeader(PC_TO_RDR_GETSLOTSTATUS, 0, 0, seq, 0x00, 0x00, 0x00)
        return this.sendAndReceive(header)
    }

    transmit(apdu: Buffer, timeout?: number): CcidResponse {
        const seq = this.nextSeq()
        const header = this.buildHeader(PC_TO_RDR_XFRBLOCK, apdu.length, 0, seq, 0x00, 0x00, 0x00)
        const msg = Buffer.concat([header, apdu])
        return this.sendAndReceive(msg, timeout)
    }

    isCardPresent(): boolean {
        const status = this.getSlotStatus()
        return status.iccStatus !== ICC_STATUS_NOT_PRESENT
    }

    isSuccess(resp: CcidResponse): boolean {
        return resp.cmdStatus === CMD_STATUS_SUCCESS
    }
}
