/**
 * WRFCoin Data Processing Worker Thread
 *
 * Worker thread for parallel processing of weather data chunks.
 * Handles data preprocessing, validation, and transformation in isolation.
 */

const { parentPort, workerData } = require('worker_threads');
const { DataPreprocessor } = require('../data-preprocessor');
const { weatherLogger } = require('../../utils/logger.js');

// Worker main execution
async function processDataChunk() {
  try {
    const { dataChunk, batch, options, index } = workerData;

    // Initialize preprocessor with options
    const preprocessor = new DataPreprocessor(
      options.preprocessorOptions || {}
    );

    const processedData = [];

    // Process each data item in the chunk
    for (const dataItem of dataChunk) {
      try {
        const processed = await preprocessor.process(dataItem, {
          source: 'noaa-ncei',
          normalizeUnits: true,
          validateFormat: true,
          enrichData: true,
        });

        if (processed) {
          processedData.push(processed);
        }
      } catch (error) {
        // Log error but continue processing other items
        weatherLogger.error(`Worker ${index}: Error processing data item`, {
          error: error.message,
        });
      }
    }

    // Send results back to main thread
    parentPort.postMessage(processedData);
  } catch (error) {
    // Send error back to main thread
    parentPort.postMessage({ error: error.message });
  }
}

// Start processing
if (parentPort) {
  processDataChunk();
}
