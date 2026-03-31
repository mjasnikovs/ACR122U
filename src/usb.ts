import {dlopen, FFIType, ptr, read as ffiRead} from 'bun:ffi'
import {readdirSync, readFileSync} from 'node:fs'
import {
    O_RDWR,
    USBDEVFS_BULK,
    USBDEVFS_CLAIMINTERFACE,
    USBDEVFS_DISCONNECT,
    USBDEVFS_IOCTL,
    USBDEVFS_RELEASEINTERFACE,
    USBDEVFS_RESET,
    VENDOR_ID,
    PRODUCT_ID,
    INTERFACE_NUM,
    DEFAULT_TIMEOUT
} from './types.ts'

const libc = dlopen('libc.so.6', {
    open: {args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32},
    close: {args: [FFIType.i32], returns: FFIType.i32},
    ioctl: {args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32},
    __errno_location: {args: [], returns: FFIType.ptr}
})

function getErrno(): number {
    const errPtr = libc.symbols.__errno_location()
    if (!errPtr) return -1
    return ffiRead.i32(errPtr, 0)
}

function errnoMessage(errno: number): string {
    const messages: Record<number, string> = {
        1: 'EPERM',
        2: 'ENOENT',
        5: 'EIO',
        9: 'EBADF',
        11: 'EAGAIN',
        12: 'ENOMEM',
        13: 'EACCES',
        16: 'EBUSY',
        19: 'ENODEV',
        22: 'EINVAL',
        32: 'EPIPE',
        61: 'ENODATA',
        62: 'ETIME',
        110: 'ETIMEDOUT'
    }
    return messages[errno] ?? `errno=${errno}`
}

function throwIfError(ret: number, msg: string): void {
    if (ret < 0) {
        const errno = getErrno()
        throw new Error(`${msg}: ${errnoMessage(errno)} (${errno})`)
    }
}

export class UsbDevice {
    private fd = -1
    private _path = ''
    private claimed = false

    get path(): string {
        return this._path
    }

    get isOpen(): boolean {
        return this.fd >= 0
    }

    static findDevice(): string | null {
        const basePath = '/sys/bus/usb/devices'
        try {
            const entries = readdirSync(basePath)
            for (const entry of entries) {
                try {
                    const vendorPath = `${basePath}/${entry}/idVendor`
                    const productPath = `${basePath}/${entry}/idProduct`
                    const vendor = readFileSync(vendorPath, 'utf-8').trim()
                    const product = readFileSync(productPath, 'utf-8').trim()

                    if (
                        parseInt(vendor, 16) === VENDOR_ID
                        && parseInt(product, 16) === PRODUCT_ID
                    ) {
                        const busnum = readFileSync(`${basePath}/${entry}/busnum`, 'utf-8').trim()
                        const devnum = readFileSync(`${basePath}/${entry}/devnum`, 'utf-8').trim()
                        return `/dev/bus/usb/${busnum.padStart(3, '0')}/${devnum.padStart(3, '0')}`
                    }
                } catch {
                    // not a USB device entry, skip
                }
            }
        } catch {
            // sysfs not available
        }
        return null
    }

    open(devicePath?: string): void {
        const path = devicePath ?? UsbDevice.findDevice()
        if (!path) {
            throw new Error('ACR122U not found. Is the device connected?')
        }

        this._path = path
        const pathBuf = Buffer.from(path + '\0')
        this.fd = libc.symbols.open(ptr(pathBuf), O_RDWR)
        if (this.fd < 0) {
            const errno = getErrno()
            throw new Error(`Failed to open ${path}: ${errnoMessage(errno)}`)
        }
    }

    close(): void {
        if (this.claimed) {
            this.releaseInterface()
        }
        if (this.fd >= 0) {
            libc.symbols.close(this.fd)
            this.fd = -1
        }
        this.claimed = false
    }

    detachKernelDriver(): void {
        const buf = Buffer.alloc(16)
        buf.writeInt32LE(INTERFACE_NUM, 0)
        buf.writeInt32LE(USBDEVFS_DISCONNECT, 4)
        buf.writeBigUInt64LE(0n, 8)

        // ENODATA (-61) means no driver attached, which is fine
        libc.symbols.ioctl(this.fd, USBDEVFS_IOCTL, ptr(buf))
    }

    claimInterface(): void {
        const buf = Buffer.alloc(4)
        buf.writeUInt32LE(INTERFACE_NUM, 0)
        const ret = libc.symbols.ioctl(this.fd, USBDEVFS_CLAIMINTERFACE, ptr(buf))
        throwIfError(ret, 'Failed to claim interface')
        this.claimed = true
    }

    releaseInterface(): void {
        const buf = Buffer.alloc(4)
        buf.writeUInt32LE(INTERFACE_NUM, 0)
        libc.symbols.ioctl(this.fd, USBDEVFS_RELEASEINTERFACE, ptr(buf))
        this.claimed = false
    }

    resetDevice(): void {
        // Must release interface before reset
        if (this.claimed) this.releaseInterface()
        const nullBuf = Buffer.alloc(8)
        libc.symbols.ioctl(this.fd, USBDEVFS_RESET, ptr(nullBuf))
    }

    /** Drain any pending data from bulk IN endpoint */
    flush(endpoint: number, maxAttempts = 10): void {
        const data = Buffer.alloc(256)
        const buf = Buffer.alloc(24)
        for (let i = 0; i < maxAttempts; i++) {
            buf.writeUInt32LE(endpoint, 0)
            buf.writeUInt32LE(256, 4)
            buf.writeUInt32LE(100, 8) // 100ms short timeout
            buf.writeBigUInt64LE(BigInt(ptr(data)), 16)
            const ret = libc.symbols.ioctl(this.fd, USBDEVFS_BULK, ptr(buf))
            if (ret <= 0) break // no more pending data
        }
    }

    bulkWrite(endpoint: number, data: Buffer, timeout = DEFAULT_TIMEOUT): number {
        const buf = Buffer.alloc(24)
        buf.writeUInt32LE(endpoint, 0)
        buf.writeUInt32LE(data.length, 4)
        buf.writeUInt32LE(timeout, 8)
        buf.writeBigUInt64LE(BigInt(ptr(data)), 16)

        const ret = libc.symbols.ioctl(this.fd, USBDEVFS_BULK, ptr(buf))
        throwIfError(ret, `Bulk write to EP 0x${endpoint.toString(16)} failed`)
        return ret
    }

    bulkRead(endpoint: number, length: number, timeout = DEFAULT_TIMEOUT): Buffer {
        const data = Buffer.alloc(length)
        const buf = Buffer.alloc(24)
        buf.writeUInt32LE(endpoint, 0)
        buf.writeUInt32LE(length, 4)
        buf.writeUInt32LE(timeout, 8)
        buf.writeBigUInt64LE(BigInt(ptr(data)), 16)

        const ret = libc.symbols.ioctl(this.fd, USBDEVFS_BULK, ptr(buf))
        throwIfError(ret, `Bulk read from EP 0x${endpoint.toString(16)} failed`)
        return data.subarray(0, ret)
    }

    interruptRead(endpoint: number, length: number, timeout = DEFAULT_TIMEOUT): Buffer | null {
        const data = Buffer.alloc(length)
        const buf = Buffer.alloc(24)
        buf.writeUInt32LE(endpoint, 0)
        buf.writeUInt32LE(length, 4)
        buf.writeUInt32LE(timeout, 8)
        buf.writeBigUInt64LE(BigInt(ptr(data)), 16)

        const ret = libc.symbols.ioctl(this.fd, USBDEVFS_BULK, ptr(buf))
        if (ret < 0) return null
        return data.subarray(0, ret)
    }
}
