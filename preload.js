const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentBridge', {
  onAgentEvent: (callback) => ipcRenderer.on('agent-event', (_, data) => callback(data))
});
