import React, { useState, useEffect, useRef } from 'react';
import { Send, Paperclip, Download, FileText, Image, Loader2, Bot, User, Mic, MicOff, Trash2, RefreshCw } from 'lucide-react';

// Define types for our data structures
interface FileData {
  id: number;
  name: string;
  type: string;
  size: number;
  data: string | ArrayBuffer | Blob;
  url: string;
}

interface Message {
  id: number;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
  files: FileData[];
  html?: string; // For HTML form content
  pdfUrl?: string; // For PDF download links
}

interface SessionData {
  sessionId: string;
  messages: Message[];
  createdAt: Date;
  lastActivity: Date;
}

const ChatInterface = () => {
  // Load session from localStorage or create new
  const [sessionId, setSessionId] = useState<string>(() => {
    const stored = localStorage.getItem('currentSessionId');
    if (stored) {
      return stored;
    }
    const newId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('currentSessionId', newId);
    return newId;
  });

  const [messages, setMessages] = useState<Message[]>(() => {
    const stored = localStorage.getItem(`session_${sessionId}_messages`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return parsed.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
      } catch (e) {
        console.error('Failed to parse stored messages:', e);
        return [];
      }
    }
    return [];
  });

  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<FileData[]>([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const formContainerRef = useRef<HTMLDivElement>(null);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(`session_${sessionId}_messages`, JSON.stringify(messages));
      localStorage.setItem(`session_${sessionId}_lastActivity`, new Date().toISOString());
    }
  }, [messages, sessionId]);

  // WebSocket connection for real-time chat
  useEffect(() => {
    const connectWebSocket = () => {
      try {
        wsRef.current = new WebSocket(`ws://localhost:3001/chat?sessionId=${sessionId}`);
        
        wsRef.current.onopen = () => {
          setIsConnected(true);
          console.log('Connected to chat server');
          
          // Send session recovery message if we have existing messages
          if (messages.length > 0) {
            wsRef.current?.send(JSON.stringify({
              type: 'session_recovery',
              sessionId: sessionId,
              messageCount: messages.length
            }));
          }
        };
        
        wsRef.current.onmessage = (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          
          if (data.type === 'message') {
            const newMessage: Message = {
              id: Date.now(),
              text: data.content,
              sender: 'bot' as const,
              timestamp: new Date(),
              files: (data.files || []) as FileData[],
              html: data.html,
              pdfUrl: data.pdfUrl
            };
            
            setMessages(prev => [...prev, newMessage]);
            setIsTyping(false);
            
            // If message contains HTML form, render it
            if (data.html) {
              setTimeout(() => renderHTMLForm(data.html), 100);
            }
          } else if (data.type === 'typing') {
            setIsTyping(data.isTyping);
          } else if (data.type === 'pdf_ready') {
            // Update the last message with PDF URL
            setMessages(prev => {
              const updated = [...prev];
              if (updated.length > 0) {
                updated[updated.length - 1].pdfUrl = data.pdfUrl;
              }
              return updated;
            });
          }
        };
        
        wsRef.current.onclose = () => {
          setIsConnected(false);
          console.log('Disconnected from chat server');
          setTimeout(connectWebSocket, 3000);
        };
        
        wsRef.current.onerror = (error: Event) => {
          console.error('WebSocket error:', error);
          setIsConnected(false);
        };
      } catch (error) {
        console.error('Failed to connect:', error);
        setIsConnected(false);
      }
    };
    
    connectWebSocket();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [sessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Clear session
  const clearSession = () => {
    if (!showClearConfirm) {
      setShowClearConfirm(true);
      setTimeout(() => setShowClearConfirm(false), 5000);
      return;
    }

    // Clear localStorage
    localStorage.removeItem(`session_${sessionId}_messages`);
    localStorage.removeItem(`session_${sessionId}_lastActivity`);
    localStorage.removeItem('currentSessionId');
    
    // Generate new session ID
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    setSessionId(newSessionId);
    localStorage.setItem('currentSessionId', newSessionId);
    
    // Clear messages
    setMessages([]);
    setShowClearConfirm(false);
    
    // Notify server about session clear
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'clear_session',
        oldSessionId: sessionId,
        newSessionId: newSessionId
      }));
    }
    
    // Reconnect with new session
    if (wsRef.current) {
      wsRef.current.close();
    }
  };

  // Render HTML form in message
  const renderHTMLForm = (html: string) => {
    if (!formContainerRef.current) return;
    
    // Create a container for the form
    const container = document.createElement('div');
    container.innerHTML = html;
    
    // Add event listeners to form elements
    const form = container.querySelector('form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        handleFormSubmit(form);
      });
      
      // Add styling to form elements
      form.classList.add('space-y-4', 'p-4', 'bg-white/10', 'rounded-lg');
      
      // Style all inputs
      form.querySelectorAll('input, select, textarea').forEach((input) => {
        input.classList.add(
          'w-full', 'px-3', 'py-2', 'bg-white/20', 'border', 
          'border-white/30', 'rounded', 'text-white', 
          'placeholder-gray-300', 'focus:outline-none', 
          'focus:ring-2', 'focus:ring-blue-500'
        );
      });
      
      // Style submit button
      form.querySelectorAll('button[type="submit"]').forEach((button) => {
        button.classList.add(
          'w-full', 'py-2', 'px-4', 'bg-gradient-to-r', 
          'from-blue-500', 'to-purple-600', 'text-white', 
          'rounded', 'hover:from-blue-600', 'hover:to-purple-700',
          'transition-all', 'duration-200'
        );
      });
    }
    
    formContainerRef.current.appendChild(container);
  };

  // Handle HTML form submission
  const handleFormSubmit = (form: HTMLFormElement) => {
    const formData = new FormData(form);
    const data: Record<string, any> = {};
    
    formData.forEach((value, key) => {
      data[key] = value;
    });
    
    // Send form data via WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'form_submission',
        sessionId: sessionId,
        formData: data,
        formId: form.getAttribute('data-form-id') || 'unknown'
      }));
    }
    
    // Show submission message
    const submissionMessage: Message = {
      id: Date.now(),
      text: 'Form submitted successfully. Processing...',
      sender: 'bot',
      timestamp: new Date(),
      files: []
    };
    
    setMessages(prev => [...prev, submissionMessage]);
    
    // Clear the form
    form.reset();
  };

  // Send message
  const sendMessage = async () => {
    if (!inputMessage.trim() && uploadedFiles.length === 0) return;
    if (!isConnected) {
      alert('Not connected to chat server. Please wait...');
      return;
    }
    
    const newMessage: Message = {
      id: Date.now(),
      text: inputMessage,
      sender: 'user',
      timestamp: new Date(),
      files: uploadedFiles
    };
    
    setMessages(prev => [...prev, newMessage]);
    setIsTyping(true);
    
    // Send via WebSocket
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content: inputMessage,
        files: uploadedFiles,
        sessionId: sessionId
      }));
    }
    
    setInputMessage('');
    setUploadedFiles([]);
  };

  // Handle file upload
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    
    const files = Array.from(event.target.files);
    
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (!e.target || !e.target.result) return;
        
        const fileData: FileData = {
          id: Date.now() + Math.random(),
          name: file.name,
          type: file.type,
          size: file.size,
          data: e.target.result as string | ArrayBuffer,
          url: URL.createObjectURL(file)
        };
        
        setUploadedFiles(prev => [...prev, fileData]);
      };
      
      if (file.type.startsWith('image/')) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsArrayBuffer(file);
      }
    });
    
    event.target.value = '';
  };

  // Voice recording functions remain the same...
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      
      const audioChunks: BlobPart[] = [];
      mediaRecorderRef.current.ondataavailable = (event: BlobEvent) => {
        audioChunks.push(event.data);
      };
      
      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        const audioFile: FileData = {
          id: Date.now(),
          name: `voice_message_${Date.now()}.wav`,
          type: 'audio/wav',
          size: audioBlob.size,
          data: audioBlob,
          url: URL.createObjectURL(audioBlob)
        };
        
        setUploadedFiles(prev => [...prev, audioFile]);
        stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
      alert('Could not access microphone');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Utility functions remain the same...
  const removeFile = (fileId: number) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const downloadFile = (file: FileData) => {
    const link = document.createElement('a');
    link.href = file.url || file.data as string;
    link.download = file.name;
    link.click();
  };

  const getFileIcon = (fileType: string) => {
    if (fileType.startsWith('image/')) return <Image className="w-4 h-4" />;
    return <FileText className="w-4 h-4" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* Header */}
      <div className="bg-black/20 backdrop-blur-sm border-b border-white/10 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">IntelliForm AI</h1>
              <p className="text-sm text-gray-300">
                {isConnected ? (
                  <span className="flex items-center">
                    <div className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse"></div>
                    Connected
                  </span>
                ) : (
                  <span className="flex items-center">
                    <div className="w-2 h-2 bg-red-400 rounded-full mr-2"></div>
                    Connecting...
                  </span>
                )}
              </p>
            </div>
          </div>
          
          <div className="flex items-center space-x-3">
            <div className="text-xs text-gray-400">
              Session: {sessionId.slice(-8)}
            </div>
            
            {/* Clear Session Button */}
            <button
              onClick={clearSession}
              className={`flex items-center space-x-2 px-3 py-2 rounded-lg transition-all duration-200 ${
                showClearConfirm
                  ? 'bg-red-500 text-white animate-pulse'
                  : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
              }`}
              title={showClearConfirm ? 'Click again to confirm' : 'Clear session'}
            >
              {showClearConfirm ? (
                <>
                  <RefreshCw className="w-4 h-4" />
                  <span className="text-xs">Confirm?</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  <span className="text-xs hidden sm:inline">Clear</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-transparent">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <Bot className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">Welcome to AI Assistant</h3>
            <p className="text-gray-400 max-w-md mx-auto">
              I can help you with forms, answer questions, and handle various tasks. 
              Your session is automatically saved and will persist across page refreshes.
            </p>
          </div>
        )}
        
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] sm:max-w-xs lg:max-w-md px-3 sm:px-4 py-2 sm:py-3 rounded-2xl ${
                message.sender === 'user'
                  ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white'
                  : 'bg-white/10 backdrop-blur-sm text-white border border-white/20'
              }`}
            >
              <div className="flex items-start space-x-2">
                {message.sender === 'bot' && (
                  <Bot className="w-5 h-5 mt-0.5 flex-shrink-0" />
                )}
                {message.sender === 'user' && (
                  <User className="w-5 h-5 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1">
                  {message.text && (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                      {message.text}
                    </p>
                  )}
                  
                  {/* HTML Form Content */}
                  {message.html && (
                    <div 
                      ref={formContainerRef}
                      className="mt-3"
                      dangerouslySetInnerHTML={{ __html: message.html }}
                    />
                  )}
                  
                  {/* PDF Download Link */}
                  {message.pdfUrl && (
                    <div className="mt-3">
                      <a
                        href={message.pdfUrl}
                        download
                        className="inline-flex items-center space-x-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        <span>Download PDF</span>
                      </a>
                    </div>
                  )}
                  
                  {/* Files */}
                  {message.files && message.files.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {message.files.map((file) => (
                        <div
                          key={file.id}
                          className="flex items-center space-x-2 p-2 bg-black/20 rounded-lg"
                        >
                          {getFileIcon(file.type)}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{file.name}</p>
                            <p className="text-xs text-gray-300">{formatFileSize(file.size)}</p>
                          </div>
                          {message.sender === 'bot' && (
                            <button
                              onClick={() => downloadFile(file)}
                              className="p-1 hover:bg-white/20 rounded transition-colors"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  
                  <p className="text-xs text-gray-300 mt-2">
                    {message.timestamp.toLocaleTimeString()}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ))}
        
        {/* Typing indicator */}
        {isTyping && (
          <div className="flex justify-start">
            <div className="bg-white/10 backdrop-blur-sm px-4 py-3 rounded-2xl border border-white/20">
              <div className="flex items-center space-x-2">
                <Bot className="w-5 h-5 text-white" />
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{animationDelay: '0.1s'}}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>
      
      {/* File previews */}
      {uploadedFiles.length > 0 && (
        <div className="px-3 sm:px-4 py-2 bg-black/20 backdrop-blur-sm border-t border-white/10">
          <div className="flex items-center space-x-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-transparent">
            <span className="text-sm text-gray-300 whitespace-nowrap">Files to send:</span>
            {uploadedFiles.map((file) => (
              <div key={file.id} className="flex items-center space-x-2 bg-white/10 rounded-lg p-2 min-w-0">
                {getFileIcon(file.type)}
                <span className="text-xs text-white truncate max-w-24">{file.name}</span>
                <button
                  onClick={() => removeFile(file.id)}
                  className="text-red-400 hover:text-red-300 text-xs"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Input */}
      <div className="p-4 bg-black/20 backdrop-blur-sm border-t border-white/10">
        <div className="flex items-end space-x-3">
          <div className="flex-1">
            <div className="relative">
              <textarea
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Type your message... (Shift+Enter for new line)"
                className="w-full px-4 py-3 pr-12 bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none min-h-[48px] max-h-32"
                rows={1}
                style={{
                  scrollbarWidth: 'thin',
                  scrollbarColor: 'rgba(255,255,255,0.3) transparent'
                }}
              />
            </div>
          </div>
          
          {/* File upload */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-3 bg-white/10 backdrop-blur-sm border border-white/20 rounded-xl text-gray-300 hover:text-white hover:bg-white/20 transition-all duration-200"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          
          {/* Voice recording */}
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`p-3 border border-white/20 rounded-xl transition-all duration-200 ${
              isRecording
                ? 'bg-red-500 text-white animate-pulse'
                : 'bg-white/10 backdrop-blur-sm text-gray-300 hover:text-white hover:bg-white/20'
            }`}
          >
            {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          
          {/* Send button */}
          <button
            onClick={sendMessage}
            disabled={!inputMessage.trim() && uploadedFiles.length === 0}
            className="p-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl"
          >
            {isTyping ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </button>
        </div>
        
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,.pdf,.doc,.docx,.txt,.csv,.json"
          onChange={handleFileUpload}
          className="hidden"
        />
      </div>
    </div>
  );
};

export default ChatInterface;