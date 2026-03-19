// src/chessEngine.ts

export class ChessEngine {
  private worker: Worker | null = null;
  private _syncing = false;
  private _pendingCommands: string[] = [];

  constructor() {
    this.worker = new Worker("/stockfish.js");
    this.worker.postMessage("uci");
  }

  // Send the board state and tell Stockfish to think
  evaluatePosition(fen: string, depth: number = 18) {
    if (!this.worker) return;
    this._syncing = true;
    this._pendingCommands = [
      "setoption name MultiPV value 3",
      `position fen ${fen}`,
      `go depth ${depth}`,
    ];
    this.worker.postMessage("stop");
    this.worker.postMessage("isready");
  }

  // Broaden to more lines once the position is well-understood
  widenSearch(fen: string, depth: number = 18) {
    if (!this.worker) return;
    this._syncing = true;
    this._pendingCommands = [
      "setoption name MultiPV value 5",
      `position fen ${fen}`,
      `go depth ${depth}`,
    ];
    this.worker.postMessage("stop");
    this.worker.postMessage("isready");
  }

  // Stop the current search without starting a new one
  stop() {
    if (!this.worker) return;
    this._syncing = true;
    this._pendingCommands = [];
    this.worker.postMessage("stop");
    this.worker.postMessage("isready");
  }

  // Listen for the engine's conclusions
  onMessage(callback: (data: string) => void) {
    if (!this.worker) return;
    this.worker.onmessage = (event) => {
      const data = event.data as string;

      // When readyok arrives during sync, all stale output has been flushed.
      // Now send the queued commands for the new search.
      if (data === "readyok" && this._syncing) {
        this._syncing = false;
        for (const cmd of this._pendingCommands) {
          this.worker!.postMessage(cmd);
        }
        this._pendingCommands = [];
        return;
      }

      // Suppress stale info messages while waiting for readyok
      if (this._syncing && data.startsWith("info")) {
        return;
      }

      callback(data);
    };
  }

  // Cleanup when the app closes
  terminate() {
    if (this.worker) {
      this.worker.terminate();
    }
  }
}
