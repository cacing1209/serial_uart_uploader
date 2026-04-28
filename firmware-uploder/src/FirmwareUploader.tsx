/// <reference types="w3c-web-serial" />
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ESPLoader, Transport } from 'esptool-js'
import './FirmwareUploader.css'

type Board = 'arduino-mega' | 'esp'

const BOARD_LABELS: Record<Board, string> = {
  'arduino-mega': 'Arduino Mega',
  esp: 'ESP8266 / ESP32',
}

const BOARD_EXT: Record<Board, string> = {
  'arduino-mega': '.elf',
  esp: '.bin',
}

const BAUDRATES = ['9600', '57600', '115200', '230400', '460800'] as const
type Baudrate = (typeof BAUDRATES)[number]

const LINE_ENDINGS = {
  none: '',
  nl: '\n',
  cr: '\r',
  crlf: '\r\n',
} as const
type LineEnding = keyof typeof LINE_ENDINGS

type Status =
  | { kind: 'idle' }
  | { kind: 'error' | 'info' | 'success'; text: string }

const MAX_MONITOR_CHARS = 50_000

function fileMatchesBoard(file: File, board: Board): boolean {
  return file.name.toLowerCase().endsWith(BOARD_EXT[board])
}

function toHex4(n: number | undefined): string {
  return n === undefined ? '—' : '0x' + n.toString(16).padStart(4, '0').toUpperCase()
}

function FirmwareUploader() {
  const [board, setBoard] = useState<Board | ''>('')
  const [baudrate, setBaudrate] = useState<Baudrate>('115200')
  const [monitorBaudrate, setMonitorBaudrate] = useState<Baudrate>('115200')
  const [file, setFile] = useState<File | null>(null)
  const [offset, setOffset] = useState('0x0')
  const [port, setPort] = useState<SerialPort | null>(null)
  const [portInfo, setPortInfo] = useState<{ vid?: number; pid?: number } | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [flashLog, setFlashLog] = useState('')
  const [progress, setProgress] = useState<number | null>(null)

  const [monitorOpen, setMonitorOpen] = useState(false)
  const [monitorLog, setMonitorLog] = useState('')
  const [monitorInput, setMonitorInput] = useState('')
  const [lineEnding, setLineEnding] = useState<LineEnding>('nl')

  const transportRef = useRef<Transport | null>(null)
  const monitorOpenRef = useRef(false)
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null)
  const loopRef = useRef<Promise<void> | null>(null)

  const appendFlashLog = (chunk: string) => setFlashLog((prev) => prev + chunk)

  const appendMonitor = (chunk: string) =>
    setMonitorLog((prev) => {
      const next = prev + chunk
      return next.length > MAX_MONITOR_CHARS ? next.slice(-MAX_MONITOR_CHARS) : next
    })

  const flashTerminal = {
    clean: () => setFlashLog(''),
    writeLine: (data: string) => appendFlashLog(data + '\n'),
    write: (data: string) => appendFlashLog(data),
  }

  const handleConnect = async () => {
    if (!('serial' in navigator)) {
      setStatus({
        kind: 'error',
        text: 'Web Serial API not supported. Use Chrome or Edge over HTTPS / localhost.',
      })
      return
    }
    try {
      const selected = await navigator.serial.requestPort()
      const info = selected.getInfo()
      setPort(selected)
      setPortInfo({ vid: info.usbVendorId, pid: info.usbProductId })
      setStatus({ kind: 'success', text: 'Device selected.' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/no port selected/i.test(msg)) {
        setStatus({ kind: 'error', text: `Connect failed: ${msg}` })
      }
    }
  }

  const handleDisconnect = async () => {
    if (monitorOpenRef.current) await closeMonitor()
    try {
      await transportRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    transportRef.current = null
    setPort(null)
    setPortInfo(null)
    setStatus({ kind: 'idle' })
  }

  const handleBoardChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setBoard(e.target.value as Board | '')
    setFile(null)
    setStatus({ kind: 'idle' })
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null
    setFile(picked)
    if (picked && board && !fileMatchesBoard(picked, board)) {
      setStatus({ kind: 'error', text: 'Invalid file format for selected board' })
    } else {
      setStatus({ kind: 'idle' })
    }
  }

  const runReadLoop = async (p: SerialPort) => {
    const decoder = new TextDecoder()
    try {
      while (p.readable && monitorOpenRef.current) {
        const reader = p.readable.getReader()
        readerRef.current = reader
        try {
          while (monitorOpenRef.current) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) appendMonitor(decoder.decode(value, { stream: true }))
          }
        } catch {
          break
        } finally {
          try {
            reader.releaseLock()
          } catch {
            /* ignore */
          }
          if (readerRef.current === reader) readerRef.current = null
        }
      }
    } finally {
      if (monitorOpenRef.current) {
        // exited unexpectedly (e.g., device unplugged)
        monitorOpenRef.current = false
        setMonitorOpen(false)
        try {
          writerRef.current?.releaseLock()
        } catch {
          /* ignore */
        }
        writerRef.current = null
        try {
          await p.close()
        } catch {
          /* ignore */
        }
        setStatus({ kind: 'error', text: 'Serial monitor disconnected.' })
      }
    }
  }

  const openMonitor = async () => {
    if (!port || monitorOpenRef.current) return
    try {
      await port.open({ baudRate: parseInt(monitorBaudrate, 10) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ kind: 'error', text: `Open monitor failed: ${msg}` })
      return
    }
    if (port.writable) {
      writerRef.current = port.writable.getWriter()
    }
    monitorOpenRef.current = true
    setMonitorOpen(true)
    setStatus({ kind: 'info', text: `Monitor open @ ${monitorBaudrate} baud` })
    loopRef.current = runReadLoop(port)
  }

  const closeMonitor = async () => {
    if (!monitorOpenRef.current) return
    monitorOpenRef.current = false
    try {
      await readerRef.current?.cancel()
    } catch {
      /* ignore */
    }
    if (loopRef.current) {
      try {
        await loopRef.current
      } catch {
        /* ignore */
      }
      loopRef.current = null
    }
    try {
      writerRef.current?.releaseLock()
    } catch {
      /* ignore */
    }
    writerRef.current = null
    try {
      await port?.close()
    } catch {
      /* ignore */
    }
    setMonitorOpen(false)
    setStatus({ kind: 'idle' })
  }

  const handleSend = async () => {
    if (!writerRef.current) return
    const text = monitorInput + LINE_ENDINGS[lineEnding]
    try {
      await writerRef.current.write(new TextEncoder().encode(text))
      appendMonitor(`> ${monitorInput}\n`)
      setMonitorInput('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ kind: 'error', text: `Send failed: ${msg}` })
    }
  }

  const flashEsp = async (selectedPort: SerialPort, fwFile: File) => {
    setFlashLog('')
    setProgress(0)

    const transport = new Transport(selectedPort, true)
    transportRef.current = transport

    const esploader = new ESPLoader({
      transport,
      baudrate: parseInt(baudrate, 10),
      terminal: flashTerminal,
    })

    const chip = await esploader.main()
    appendFlashLog(`\nDetected chip: ${chip}\n`)

    const addr = parseInt(offset, 16)
    if (Number.isNaN(addr)) throw new Error(`Invalid offset: ${offset}`)

    const data = new Uint8Array(await fwFile.arrayBuffer())

    await esploader.writeFlash({
      fileArray: [{ data, address: addr }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) => {
        setProgress(Math.round((written / total) * 100))
      },
    })

    appendFlashLog('\nFlash complete.\n')
    setStatus({ kind: 'success', text: `Uploaded ${fwFile.name} successfully` })
  }

  const handleUpload = async () => {
    if (!board) {
      setStatus({ kind: 'error', text: 'Please select a board first' })
      return
    }
    if (!baudrate) {
      setStatus({ kind: 'error', text: 'Please select a baudrate' })
      return
    }
    if (!file) {
      setStatus({ kind: 'error', text: 'Please upload a firmware file' })
      return
    }
    if (!fileMatchesBoard(file, board)) {
      setStatus({ kind: 'error', text: 'Invalid file format for selected board' })
      return
    }
    if (!port) {
      setStatus({ kind: 'error', text: 'Please connect a device first' })
      return
    }

    setBusy(true)
    setStatus({ kind: 'info', text: 'Uploading firmware...' })

    try {
      if (monitorOpenRef.current) await closeMonitor()

      if (board === 'esp') {
        await flashEsp(port, file)
      } else {
        await new Promise((r) => setTimeout(r, 800))
        setStatus({
          kind: 'info',
          text: 'Arduino flashing is not implemented yet (UI only).',
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ kind: 'error', text: `Upload failed: ${msg}` })
    } finally {
      try {
        await transportRef.current?.disconnect()
      } catch {
        /* ignore */
      }
      transportRef.current = null
      setBusy(false)
    }
  }

  const accept = board ? BOARD_EXT[board] : undefined
  const showSummary = board && baudrate

  return (
    <div className="uploader">
      <h1>Firmware Uploader</h1>

      <div className="connect-row">
        {!port ? (
          <button
            type="button"
            className="connect-btn"
            onClick={handleConnect}
            disabled={busy}
          >
            Connect Device
          </button>
        ) : (
          <>
            <div className="port-info">
              <strong>Connected</strong>
              <span>
                VID {toHex4(portInfo?.vid)} · PID {toHex4(portInfo?.pid)}
              </span>
            </div>
            <button
              type="button"
              className="disconnect-btn"
              onClick={handleDisconnect}
              disabled={busy}
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      <label className="field">
        <span>Board</span>
        <select value={board} onChange={handleBoardChange} disabled={busy}>
          <option value="">— Select a board —</option>
          <option value="arduino-mega">Arduino Mega</option>
          <option value="esp">ESP8266 / ESP32</option>
        </select>
      </label>

      <label className="field">
        <span>Baudrate</span>
        <select
          value={baudrate}
          onChange={(e) => setBaudrate(e.target.value as Baudrate)}
          disabled={busy || monitorOpen}
        >
          {BAUDRATES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Firmware file{board ? ` (${BOARD_EXT[board]})` : ''}</span>
        <input
          key={board}
          type="file"
          accept={accept}
          onChange={handleFileChange}
          disabled={busy || !board}
        />
      </label>

      {board === 'esp' && (
        <label className="field">
          <span>Flash offset (hex)</span>
          <input
            type="text"
            value={offset}
            onChange={(e) => setOffset(e.target.value)}
            disabled={busy}
            placeholder="0x0"
          />
        </label>
      )}

      {showSummary && (
        <div className="summary">
          <div>
            <strong>Board:</strong> {BOARD_LABELS[board as Board]}
          </div>
          <div>
            <strong>Baudrate:</strong> {baudrate}
          </div>
          {file && (
            <div>
              <strong>File:</strong> {file.name}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className="upload-btn"
        onClick={handleUpload}
        disabled={busy}
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>

      {progress !== null && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
          <div className="progress-text">{progress}%</div>
        </div>
      )}

      {status.kind !== 'idle' && (
        <div className={`status status-${status.kind}`} role="status">
          {status.text}
        </div>
      )}

      {flashLog && <pre className="log">{flashLog}</pre>}

      {port && (
        <section className="monitor">
          <div className="monitor-header">
            <h2>Serial Monitor</h2>
            <div className="monitor-actions">
              <select
                className="monitor-baud"
                value={monitorBaudrate}
                onChange={(e) => setMonitorBaudrate(e.target.value as Baudrate)}
                disabled={busy || monitorOpen}
                title="Monitor baudrate"
              >
                {BAUDRATES.map((b) => (
                  <option key={b} value={b}>
                    {b} baud
                  </option>
                ))}
              </select>
              {!monitorOpen ? (
                <button
                  type="button"
                  className="connect-btn"
                  onClick={openMonitor}
                  disabled={busy}
                >
                  Open Monitor
                </button>
              ) : (
                <button
                  type="button"
                  className="disconnect-btn"
                  onClick={closeMonitor}
                  disabled={busy}
                >
                  Close Monitor
                </button>
              )}
              <button
                type="button"
                className="disconnect-btn"
                onClick={() => setMonitorLog('')}
                disabled={busy || !monitorLog}
              >
                Clear
              </button>
            </div>
          </div>

          <pre className="log monitor-log">{monitorLog || '(no data)'}</pre>

          <div className="monitor-send">
            <input
              type="text"
              value={monitorInput}
              onChange={(e) => setMonitorInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend()
              }}
              placeholder={monitorOpen ? 'Type and press Enter…' : 'Open monitor to send'}
              disabled={!monitorOpen || busy}
            />
            <select
              value={lineEnding}
              onChange={(e) => setLineEnding(e.target.value as LineEnding)}
              disabled={!monitorOpen || busy}
              title="Line ending"
            >
              <option value="none">No line ending</option>
              <option value="nl">NL (\n)</option>
              <option value="cr">CR (\r)</option>
              <option value="crlf">CR+NL (\r\n)</option>
            </select>
            <button
              type="button"
              className="connect-btn"
              onClick={handleSend}
              disabled={!monitorOpen || busy}
            >
              Send
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

export default FirmwareUploader
