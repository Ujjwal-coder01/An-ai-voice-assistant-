
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveSession, LiveServerMessage, Blob } from '@google/genai';
import { Message, AssistantStatus } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const SYSTEM_INSTRUCTION = "You are 'Echo', an expert AI exam tutor. Your goal is to explain complex topics clearly and concisely to help students understand. Be patient, encouraging, and use simple analogies when possible. Keep your answers focused and to the point.";

const StatusIndicator: React.FC<{ status: AssistantStatus }> = ({ status }) => {
    const getStatusInfo = () => {
        switch (status) {
            case 'listening':
                return { text: 'Listening...', color: 'bg-green-500' };
            case 'speaking':
            case 'thinking':
                return { text: 'AI is responding...', color: 'bg-blue-500' };
            case 'error':
                return { text: 'Error', color: 'bg-red-500' };
            case 'idle':
            default:
                return { text: 'Ready to help', color: 'bg-gray-500' };
        }
    };

    const { text, color } = getStatusInfo();

    return (
        <div className="flex flex-col items-center justify-center space-y-4">
            <div className="relative flex items-center justify-center w-24 h-24">
                <div className={`absolute w-full h-full rounded-full ${color} ${status === 'listening' || status === 'speaking' ? 'animate-ping' : ''}`}></div>
                <div className={`relative w-20 h-20 rounded-full ${color} transition-colors duration-300`}></div>
            </div>
            <p className="text-lg text-gray-300 capitalize">{text}</p>
        </div>
    );
};


const App: React.FC = () => {
    const [status, setStatus] = useState<AssistantStatus>('idle');
    const [conversation, setConversation] = useState<Message[]>([]);
    const [error, setError] = useState<string | null>(null);

    const liveSessionPromise = useRef<Promise<LiveSession> | null>(null);
    const inputAudioContext = useRef<AudioContext | null>(null);
    const outputAudioContext = useRef<AudioContext | null>(null);
    const microphoneStream = useRef<MediaStream | null>(null);
    const scriptProcessorNode = useRef<ScriptProcessorNode | null>(null);

    const userInputRef = useRef<string>('');
    const aiOutputRef = useRef<string>('');
    const nextAudioStartTime = useRef<number>(0);
    const audioSources = useRef<Set<AudioBufferSourceNode>>(new Set());
    
    const conversationEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [conversation]);
    
    const handleMessage = useCallback(async (message: LiveServerMessage) => {
        if (message.serverContent?.outputTranscription) {
            aiOutputRef.current += message.serverContent.outputTranscription.text;
        } else if (message.serverContent?.inputTranscription) {
            userInputRef.current += message.serverContent.inputTranscription.text;
        }

        if (message.serverContent?.turnComplete) {
            const userText = userInputRef.current.trim();
            const aiText = aiOutputRef.current.trim();

            if (userText) {
                setConversation(prev => [...prev, { id: Date.now(), speaker: 'user', text: userText }]);
            }
            if (aiText) {
                setConversation(prev => [...prev, { id: Date.now() + 1, speaker: 'ai', text: aiText }]);
            }

            userInputRef.current = '';
            aiOutputRef.current = '';
            setStatus('listening');
        }

        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
        if (base64Audio && outputAudioContext.current) {
            setStatus('speaking');
            nextAudioStartTime.current = Math.max(nextAudioStartTime.current, outputAudioContext.current.currentTime);
            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext.current, OUTPUT_SAMPLE_RATE, 1);
            
            const source = outputAudioContext.current.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(outputAudioContext.current.destination);
            
            source.addEventListener('ended', () => {
                audioSources.current.delete(source);
                if (audioSources.current.size === 0) {
                   setStatus('listening');
                }
            });

            source.start(nextAudioStartTime.current);
            nextAudioStartTime.current += audioBuffer.duration;
            audioSources.current.add(source);
        }

        if (message.serverContent?.interrupted) {
            for (const source of audioSources.current.values()) {
                source.stop();
                audioSources.current.delete(source);
            }
            nextAudioStartTime.current = 0;
            setStatus('listening');
        }
    }, []);

    const handleError = useCallback((e: ErrorEvent) => {
        console.error('Session error:', e);
        setError('An error occurred with the connection. Please try again.');
        setStatus('error');
        stopSession();
    }, []);

    const handleClose = useCallback(() => {
        if (status !== 'error') {
          console.log('Session closed.');
        }
    }, [status]);
    
    const stopSession = useCallback(async () => {
        setStatus('idle');
        
        if (liveSessionPromise.current) {
            const session = await liveSessionPromise.current;
            session.close();
            liveSessionPromise.current = null;
        }

        if (microphoneStream.current) {
            microphoneStream.current.getTracks().forEach(track => track.stop());
            microphoneStream.current = null;
        }

        if (scriptProcessorNode.current) {
            scriptProcessorNode.current.disconnect();
            scriptProcessorNode.current = null;
        }

        if (inputAudioContext.current && inputAudioContext.current.state !== 'closed') {
            await inputAudioContext.current.close();
            inputAudioContext.current = null;
        }
        if (outputAudioContext.current && outputAudioContext.current.state !== 'closed') {
            await outputAudioContext.current.close();
            outputAudioContext.current = null;
        }
    }, []);

    const startSession = useCallback(async () => {
        setError(null);
        setStatus('thinking');
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            microphoneStream.current = stream;

            // Fix: Address TypeScript error for `webkitAudioContext` by using a compatibility constant.
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            inputAudioContext.current = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
            outputAudioContext.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
            nextAudioStartTime.current = 0;

            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
            liveSessionPromise.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        const source = inputAudioContext.current!.createMediaStreamSource(stream);
                        scriptProcessorNode.current = inputAudioContext.current!.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorNode.current.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const l = inputData.length;
                            const int16 = new Int16Array(l);
                            for (let i = 0; i < l; i++) {
                                int16[i] = inputData[i] * 32768;
                            }
                            const pcmBlob: Blob = {
                                data: encode(new Uint8Array(int16.buffer)),
                                mimeType: 'audio/pcm;rate=16000',
                            };
                            liveSessionPromise.current?.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        
                        source.connect(scriptProcessorNode.current);
                        scriptProcessorNode.current.connect(inputAudioContext.current!.destination);
                        setStatus('listening');
                    },
                    onmessage: handleMessage,
                    onerror: handleError,
                    onclose: handleClose,
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' }}},
                    systemInstruction: SYSTEM_INSTRUCTION,
                },
            });

        } catch (err) {
            console.error('Failed to start session:', err);
            setError('Could not access microphone. Please grant permission and try again.');
            setStatus('error');
            await stopSession();
        }
    }, [handleMessage, handleError, handleClose, stopSession]);

    const toggleSession = useCallback(() => {
        if (status === 'idle' || status === 'error') {
            startSession();
        } else {
            stopSession();
        }
    }, [status, startSession, stopSession]);

    return (
        <div className="flex flex-col h-screen bg-gray-900 text-gray-100 p-4 max-w-4xl mx-auto">
            <header className="text-center mb-4">
                <h1 className="text-3xl font-bold text-blue-400">AI Exam Voice Assistant</h1>
                <p className="text-gray-400">Your personal tutor, ready to explain anything.</p>
            </header>

            <main className="flex-grow flex flex-col bg-gray-800/50 rounded-lg p-4 overflow-y-auto mb-4 min-h-0">
                {conversation.length === 0 && (
                    <div className="flex-grow flex items-center justify-center text-center text-gray-400">
                        <p>Press the button below and start speaking to ask a question.</p>
                    </div>
                )}
                {conversation.map((msg) => (
                    <div key={msg.id} className={`flex my-2 ${msg.speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-prose rounded-lg px-4 py-2 ${msg.speaker === 'user' ? 'bg-blue-600' : 'bg-gray-700'}`}>
                           <p className="text-white">{msg.text}</p>
                        </div>
                    </div>
                ))}
                <div ref={conversationEndRef} />
            </main>

            {error && <div className="text-center text-red-400 mb-4">{error}</div>}

            <footer className="flex flex-col items-center justify-center space-y-6">
                <StatusIndicator status={status} />
                <button
                    onClick={toggleSession}
                    className={`px-8 py-4 rounded-full text-lg font-semibold transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-opacity-50 ${
                        (status === 'idle' || status === 'error')
                            ? 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'
                            : 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                    }`}
                >
                    {(status === 'idle' || status === 'error') ? 'Start Session' : 'Stop Session'}
                </button>
            </footer>
        </div>
    );
};

export default App;
