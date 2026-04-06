import { io } from 'socket.io-client'

// Connect to your local server
const socket = io('http://localhost:3001')

socket.on('connect', () => {
  console.log('Connected to FeltClub server!')
})

socket.on('disconnect', () => {
  console.log('Disconnected from server')
})

export default socket
