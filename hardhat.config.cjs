require('@nomicfoundation/hardhat-toolbox');

/** Build output stays out of the repo; the app reads the deployed ABI + address from deployments/kite-testnet.json. */
module.exports = {
  solidity: { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' } },
  paths: { tests: './test', artifacts: './hh-artifacts', cache: './hh-cache' },
};
