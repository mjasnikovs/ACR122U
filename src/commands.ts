import {ACR_CLA, MIFARE_DEFAULT_KEY, MIFARE_KEY_A, MIFARE_KEY_B} from './types.ts'

/** Build an APDU command buffer */
function apdu(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Buffer,
    le?: number
): Buffer {
    const parts: number[] = [cla, ins, p1, p2]
    if (data && data.length > 0) {
        parts.push(data.length)
        parts.push(...data)
    }
    if (le !== undefined) {
        parts.push(le)
    }
    return Buffer.from(parts)
}

/** Get reader firmware version string */
export function getFirmwareVersion(): Buffer {
    return apdu(ACR_CLA, 0x00, 0x48, 0x00, undefined, 0x00)
}

/** Get card UID */
export function getUid(): Buffer {
    return apdu(ACR_CLA, 0xca, 0x00, 0x00, undefined, 0x00)
}

/** Get card ATS/ATR data */
export function getAts(): Buffer {
    return apdu(ACR_CLA, 0xca, 0x01, 0x00, undefined, 0x00)
}

/** Load authentication key into reader key slot (0 or 1) */
export function loadKey(keySlot: number, key: Buffer = MIFARE_DEFAULT_KEY): Buffer {
    return apdu(ACR_CLA, 0x82, 0x00, keySlot & 0x01, key)
}

/** Authenticate a MIFARE block using a loaded key */
export function authenticate(blockNumber: number, keyType: 'A' | 'B' = 'A', keySlot = 0): Buffer {
    const authData = Buffer.from([
        0x01, // version
        0x00, // byte 2 (reserved)
        blockNumber,
        keyType === 'A' ? MIFARE_KEY_A : MIFARE_KEY_B,
        keySlot & 0x01
    ])
    return apdu(ACR_CLA, 0x86, 0x00, 0x00, authData)
}

/** Read a 16-byte MIFARE block */
export function readBlock(blockNumber: number): Buffer {
    return apdu(ACR_CLA, 0xb0, 0x00, blockNumber, undefined, 0x10)
}

/** Write 16 bytes to a MIFARE block */
export function writeBlock(blockNumber: number, data: Buffer): Buffer {
    if (data.length !== 16) {
        throw new Error(`Block data must be exactly 16 bytes, got ${data.length}`)
    }
    return apdu(ACR_CLA, 0xd6, 0x00, blockNumber, data)
}

/** LED and buzzer control APDU */
export function ledControl(
    ledState: number,
    t1Duration: number,
    t2Duration: number,
    repeat: number,
    buzzerLink: number
): Buffer {
    const data = Buffer.from([t1Duration, t2Duration, repeat, buzzerLink])
    return apdu(ACR_CLA, 0x00, 0x40, ledState, data)
}

/** Buzzer control: 0x00=off, 0xFF=on during card detection */
export function buzzerControl(state: number): Buffer {
    return apdu(ACR_CLA, 0x00, 0x52, state, undefined, 0x00)
}

/** Get PICC operating parameter */
export function getOperatingParameter(): Buffer {
    return apdu(ACR_CLA, 0x00, 0x50, 0x00, undefined, 0x00)
}

/** Set PICC operating parameter */
export function setOperatingParameter(param: number): Buffer {
    return apdu(ACR_CLA, 0x00, 0x51, param, undefined, 0x00)
}

/** Check APDU response status words */
export function checkSW(raw: Buffer): {
    sw1: number
    sw2: number
    success: boolean
    data: Buffer
} {
    if (raw.length < 2) {
        return {sw1: 0, sw2: 0, success: false, data: Buffer.alloc(0)}
    }
    const sw1 = raw[raw.length - 2]!
    const sw2 = raw[raw.length - 1]!
    const data = raw.subarray(0, raw.length - 2)
    return {sw1, sw2, success: sw1 === 0x90 && sw2 === 0x00, data}
}
