import axios from 'axios';

const API_BASE = 'https://pdf-editor-ax8j.onrender.com';

const api = axios.create({
    baseURL: `${API_BASE}/api`,
    headers: {
        'Content-Type': 'application/json',
    },
});

// Add a request interceptor to include the JWT token in all requests
api.interceptors.request.use(
    (config) => {
        const authData = localStorage.getItem('fin_auth_data');
        if (authData) {
            const { token } = JSON.parse(authData);
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
        }
        return config;
    },
    (error) => Promise.reject(error)
);

export const authService = {
    login: async (email, password) => {
        const response = await api.post('/auth/login', { email, password });
        return response.data;
    },
    register: async (name, email, password) => {
        const response = await api.post('/auth/register', { name, email, password });
        return response.data;
    },
};

export const statementService = {
    upload: async (file, password) => {
        const formData = new FormData();
        formData.append('file', file);
        if (password) {
            formData.append('password', password);
            console.log('[API Service] Adding password to FormData');
        } else {
            console.log('[API Service] No password to add');
        }
        
        console.log('[API Service] Sending request to /statements/upload');
        
        const response = await api.post('/statements/upload', formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    },
    save: async (transactions, filename) => {
        const response = await api.post('/statements/save', { transactions, filename });
        return response.data;
    },
    saveFile: async (fileUrl, originalName, size) => {
        const response = await api.post('/statements/save-file', { fileUrl, originalName, size });
        return response.data;
    },
    deleteFile: async (id) => {
        const response = await api.delete(`/statements/${id}`);
        return response.data;
    },
    getAll: async () => {
        const response = await api.get('/statements');
        return response.data;
    },
    regenerate: async (transactions, originalFile) => {
        const response = await api.post('/statements/regenerate', { transactions, originalFile });
        return response.data;
    },
};

export { API_BASE };
export default api;
