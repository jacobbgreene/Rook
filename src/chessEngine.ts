// src/chessEngine.ts

export class ChessEngine {
  private worker: Worker | null = null;

  constructor() {
    // Vite (which Tauri uses) supports importing workers like this
    // We use the local node_modules path
    this.worker = new Worker("/stockfish.js");

    // Initialize the engine
    this.worker.postMessage("uci");
    this.worker.postMessage("isready");
  }

  // Send the board state and tell Stockfish to think
  evaluatePosition(fen: string, depth: number = 18) {
    if (!this.worker) return;
    this.worker.postMessage("stop");
    // Phase 1: narrow search (3 lines) for fast, accurate eval
    this.worker.postMessage("setoption name MultiPV value 3");
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${depth}`);
  }

  // Broaden to more lines once the position is well-understood
  widenSearch(fen: string, depth: number = 18) {
    if (!this.worker) return;
    this.worker.postMessage("stop");
    this.worker.postMessage("setoption name MultiPV value 5");
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${depth}`);
  }

  // Listen for the engine's conclusions
  onMessage(callback: (data: string) => void) {
    if (!this.worker) return;
    this.worker.onmessage = (event) => {
      callback(event.data);
    };
  }

  // Cleanup when the app closes
  terminate() {
    if (this.worker) {
      this.worker.terminate();
    }
  }
}
