require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DeepSeek API 客户端（兼容 OpenAI SDK）
const client = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || 'sk-placeholder',
});

// ==================== INTERNET ARCHIVE FULL-SONG SEARCH ====================

async function searchArchive(query, limit = 20) {
    try {
        const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+format:(MP3)+AND+mediatype:audio&fl[]=identifier&fl[]=title&fl[]=creator&output=json&rows=${limit}`;
        const resp = await fetch(searchUrl);
        const data = await resp.json();
        if (!data.response || !data.response.docs) return [];
        return data.response.docs;
    } catch (e) {
        console.error('[Archive Search] error:', e.message);
        return [];
    }
}

async function getArchiveFiles(identifier) {
    try {
        const metaUrl = `https://archive.org/metadata/${identifier}`;
        const resp = await fetch(metaUrl);
        const data = await resp.json();
        if (!data.files) return [];

        const mp3Files = data.files.filter(f =>
            f.name && f.name.toLowerCase().endsWith('.mp3') && f.size && parseInt(f.size) > 100000
        );
        mp3Files.sort((a, b) => parseInt(b.size) - parseInt(a.size));

        return mp3Files.map(f => ({
            filename: f.name,
            url: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
            size: parseInt(f.size),
            format: 'mp3',
        }));
    } catch (e) {
        console.error('[Archive Files] error:', e.message);
        return [];
    }
}

async function searchFullSongs(query, maxResults = 5) {
    console.log(`[FullSong Search] "${query}"`);
    const docs = await searchArchive(query, 20);
    if (docs.length === 0) return [];

    const results = [];
    for (const doc of docs) {
        if (results.length >= maxResults) break;
        const files = await getArchiveFiles(doc.identifier);
        if (files.length > 0) {
            results.push({
                trackId: doc.identifier,
                trackName: doc.title || '未知歌曲',
                artistName: doc.creator || '未知艺人',
                collectionName: '',
                previewUrl: files[0].url,
                artworkUrl100: `https://archive.org/services/img/${doc.identifier}`,
                artworkUrl: `https://archive.org/services/img/${doc.identifier}`,
                trackViewUrl: `https://archive.org/details/${doc.identifier}`,
                genre: '',
                source: 'archive',
                files: files.slice(0, 5),
            });
        }
    }
    return results;
}

async function searchiTunes(query, limit = 5) {
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}`;
    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();

    if (!searchData.results || searchData.results.length === 0) return [];

    const validResults = searchData.results.filter(r => r.previewUrl);
    return validResults.map(r => ({
        trackId: r.trackId,
        trackName: r.trackName,
        artistName: r.artistName,
        collectionName: r.collectionName || '',
        previewUrl: r.previewUrl,
        artworkUrl100: r.artworkUrl100 || '',
        artworkUrl: (r.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
        trackViewUrl: r.trackViewUrl || '',
        genre: r.primaryGenreName || '',
        source: 'itunes',
    }));
}

function pickRandomMusic(results, maxPick = 3) {
    if (results.length === 0) return null;
    const idx = Math.floor(Math.random() * Math.min(results.length, maxPick));
    return results[idx];
}

const FALLBACK_QUERIES = [
    'lo-fi chill beats',
    'ambient relaxing music',
    'jazz piano',
    'acoustic morning',
    'indie folk',
];

async function searchMusicWithFallback(query) {
    let results = await searchFullSongs(query, 5);
    if (results.length > 0) return results;

    results = await searchiTunes(query, 5);
    if (results.length > 0) return results;

    for (const fb of FALLBACK_QUERIES) {
        results = await searchFullSongs(fb, 3);
        if (results.length > 0) return results;
    }

    for (const fb of FALLBACK_QUERIES) {
        results = await searchiTunes(fb, 5);
        if (results.length > 0) break;
    }
    return results;
}

function getTimePeriodAndQueries() {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) {
        return { period: 'morning', label: '清晨', queries: ['morning acoustic', 'uplifting indie', 'fresh folk', 'coffee shop jazz'], greetingContext: '现在是清晨时分，新的一天刚刚开始。用清新的音乐唤醒感官。' };
    } else if (hour >= 12 && hour < 18) {
        return { period: 'afternoon', label: '午后', queries: ['cafe jazz', 'focus instrumental', 'chill bossa nova', 'ambient electronic'], greetingContext: '午后时光，阳光正好。来点咖啡厅爵士或专注音乐，让下午更美好。' };
    } else {
        return { period: 'night', label: '深夜', queries: ['lo-fi chill', 'sleep ambient', 'late night jazz', 'calm piano'], greetingContext: '夜深了，城市安静下来。用 Lo-fi 或舒缓音乐陪伴这个安静的夜晚。' };
    }
}

function buildAutoDJSystemPrompt(timeInfo) {
    return `你是一个名叫"Near"的深夜电台AI DJ。你的语气温柔、幽默、富有共情力，像一位陪伴听众度过深夜的老朋友。

当前时段：${timeInfo.label}（${timeInfo.greetingContext}）

你的风格指南：
- 像深夜电台主持人一样说话，用温柔平缓的语调
- 根据当前时段调整你的语气和内容
- 偶尔加入一些诗意的表达，但不做作
- 可以适度幽默，让人会心一笑
- 回复控制在 2-3 句话，像电台串场一样简洁有力

重要规则：
- 你必须调用 search_and_play_music 工具来搜索并播放一首适合当前时段的音乐
- 先用一段感性温暖的话欢迎听众，然后触发工具搜索音乐`;
}

const DJ_SYSTEM_PROMPT = `你是一个名叫"Near"的深夜电台AI DJ。你的语气温柔、幽默、富有共情力，像一位陪伴听众度过深夜的老朋友。

你的风格指南：
- 像深夜电台主持人一样说话，用温柔平缓的语调
- 在播放歌曲之前，先用一段感性温暖的话介绍这首歌（如"在这个安静的深夜，我想为你送上一首..."）
- 你的介绍会由语音合成器念出来，所以请用口语化的、适合朗读的语气
- 偶尔加入一些诗意的表达，但不做作
- 可以适度幽默，让人会心一笑
- 对听众的情绪保持敏锐，给予温暖的回应
- 回复控制在 2-4 句话，像电台串场一样简洁有力

重要规则：
- 当用户表达想听歌、想听某种情绪/风格的音乐时，你**必须**调用 search_and_play_music 工具来搜索并播放音乐
- 不要直接回复说你不能播放音乐 - 你拥有搜索和播放音乐的能力
- 当用户说"播放"、"来一首"、"我想听"、"放歌"、"下一首"、"换一首"等关键词时，立即调用工具
- 如果没有特别指定歌曲，根据对话情绪和氛围选一首合适的歌`;

const tools = [{
    type: 'function',
    function: {
        name: 'search_and_play_music',
        description: '搜索并播放音乐。使用 Internet Archive 搜索全曲 MP3，也可使用 iTunes Search API 搜索音乐。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词，可以是歌曲名、艺人名、或描述情绪/风格的词' },
                mood: { type: 'string', enum: ['nostalgic', 'romantic', 'energetic', 'calm', 'melancholic', 'happy', 'focused', 'sleepy'] },
            },
            required: ['query'],
        },
    },
}];

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages 数组为必填项' });

        const chatMessages = [{ role: 'system', content: DJ_SYSTEM_PROMPT }, ...messages];
        const completion = await client.chat.completions.create({ model: 'deepseek-chat', messages: chatMessages, tools, tool_choice: 'auto', temperature: 0.9, max_tokens: 1024 });
        const responseMessage = completion.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0];
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`[DJ] search_and_play_music -> "${args.query}"`);

            const results = await searchMusicWithFallback(args.query);
            const musicResult = pickRandomMusic(results);

            const assistantMsgWithTool = { role: 'assistant', content: responseMessage.content || null, tool_calls: [{ id: toolCall.id, type: 'function', function: { name: 'search_and_play_music', arguments: toolCall.function.arguments } }] };
            const toolResultMsg = { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(musicResult || { notFound: true, query: args.query }) };

            const secondCompletion = await client.chat.completions.create({ model: 'deepseek-chat', messages: [...chatMessages, assistantMsgWithTool, toolResultMsg], temperature: 0.9, max_tokens: 512 });
            const djMessage = secondCompletion.choices[0].message.content;

            res.json({ message: djMessage || `🎵 为你找到了这首歌：${musicResult?.trackName || '未知歌曲'}`, music: musicResult, mood: args.mood || null, searchQuery: args.query });
        } else {
            res.json({ message: responseMessage.content || '（Near 正在调音台前调整频率...）', music: null, mood: null, searchQuery: null });
        }
    } catch (err) {
        console.error('/api/chat 错误:', err);
        res.status(500).json({ error: '电台信号不太好，请稍后再试...', details: err.message });
    }
});

app.post('/api/auto-dj', async (req, res) => {
    try {
        const timeInfo = getTimePeriodAndQueries();
        const { messages = [] } = req.body;
        const lastQuery = req.body.lastQuery || timeInfo.queries[0];

        const chatMessages = [{ role: 'system', content: buildAutoDJSystemPrompt(timeInfo) }, ...messages.slice(-4)];
        if (messages.length === 0) chatMessages.push({ role: 'user', content: `（新听众到访，请根据当前${timeInfo.label}时段欢迎ta并推荐一首歌）` });

        const completion = await client.chat.completions.create({ model: 'deepseek-chat', messages: chatMessages, tools, tool_choice: 'auto', temperature: 0.9, max_tokens: 1024 });
        const responseMessage = completion.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0];
            const args = JSON.parse(toolCall.function.arguments);
            const query = args.query || lastQuery;

            const results = await searchMusicWithFallback(query);
            const musicResult = pickRandomMusic(results);

            const assistantMsgWithTool = { role: 'assistant', content: responseMessage.content || null, tool_calls: [{ id: toolCall.id, type: 'function', function: { name: 'search_and_play_music', arguments: toolCall.function.arguments } }] };
            const toolResultMsg = { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(musicResult || { notFound: true, query }) };

            const secondCompletion = await client.chat.completions.create({ model: 'deepseek-chat', messages: [...chatMessages, assistantMsgWithTool, toolResultMsg], temperature: 0.9, max_tokens: 512 });
            const djMessage = secondCompletion.choices[0].message.content;

            res.json({ message: djMessage || `🎵 ${timeInfo.label}好，为你准备了这首歌。`, music: musicResult, timePeriod: timeInfo.period, searchQuery: query });
        } else {
            res.json({ message: responseMessage.content || `${timeInfo.label}好，欢迎来到 NearEar。`, music: null, timePeriod: timeInfo.period, searchQuery: timeInfo.queries[0] });
        }
    } catch (err) {
        console.error('/api/auto-dj 错误:', err);
        res.status(500).json({ error: '自动DJ信号波动', details: err.message });
    }
});

app.post('/api/next-song', async (req, res) => {
    try {
        const { previousQuery, excludeTrackIds = [] } = req.body;
        const timeInfo = getTimePeriodAndQueries();
        let queries = previousQuery ? [previousQuery, previousQuery + ' similar'] : [];
        queries.push(...timeInfo.queries);

        let allResults = [];
        for (const q of queries) {
            const results = await searchMusicWithFallback(q);
            allResults.push(...results);
            if (allResults.length >= 5) break;
        }

        const seen = new Set(excludeTrackIds.map(String));
        const uniqueResults = allResults.filter(r => { const k = String(r.trackId); if (seen.has(k)) return false; seen.add(k); return true; });
        if (uniqueResults.length === 0) uniqueResults.push(...(await searchMusicWithFallback(timeInfo.queries[0])));

        const musicResult = pickRandomMusic(uniqueResults, uniqueResults.length);
        if (musicResult) console.log(`[Next Song] -> "${musicResult.trackName}" by ${musicResult.artistName} [${musicResult.source}]`);
        res.json({ music: musicResult, searchQuery: previousQuery || timeInfo.queries[0] });
    } catch (err) {
        console.error('/api/next-song 错误:', err);
        res.status(500).json({ error: '获取下一首失败', details: err.message });
    }
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`\n  📻 NearEar 深夜电台已上线\n  🎧 http://localhost:${PORT}\n`));
}

module.exports = app;