import { io } from 'socket.io-client'

const URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'
const socket = io(URL)

socket.on('connect', () => console.log('Connected!'))

export default socket