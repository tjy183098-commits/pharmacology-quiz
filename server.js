const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// ====== 班级配置 ======
const CLASSES = [
    '畜牧兽医1班', '畜牧兽医2班', '畜牧兽医3班', '畜牧兽医4班',
    '宠物1班', '宠物2班',
    '动物医学1班', '动物医学2班', '动物医学3班', '动物医学4班', '动物医学5班'
];

// ====== 配置 ======
const CONFIG = {
    teacher: {
        username: 'admin',
        password: 'pharma2026',
    },
    wechat: { enabled: false, appId: '', appSecret: '' },
    quiz: { totalQuestions: 500, perQuiz: 25, pointsPerQuestion: 5, totalScore: 125, timeLimit: 60 },
    classes: CLASSES,
};

// ====== 考试模式：题库会话存储 ======
const examSessions = {}; // { code: { questions, students: { name: { class, startTime, answers } }, createdAt, teacher } }

// 定期清理超过24小时的考试
setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    Object.keys(examSessions).forEach(code => {
        if (examSessions[code].createdAt < cutoff) delete examSessions[code];
    });
}, 60 * 60 * 1000);

function generateExamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
    secret: 'pharma-quiz-' + require('crypto').randomBytes(16).toString('hex'),
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 4 * 60 * 60 * 1000 }
}));

// ====== 题库 ======
let questionBank = [];
try { questionBank = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8')); }
catch (e) { console.error('题库加载失败:', e.message); }
function getActiveQuestions() { return questionBank.filter(q => q.status === 'ready'); }
function getRandomQuestions(count, category) {
    let active = getActiveQuestions();
    if (category && category !== 'all') {
        active = active.filter(q => q.category === category);
    }
    const shuffled = [...active].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length)).map(({ id, question, options, category }) =>
        ({ id, question, options, category }));
}

// ====== 学生登录（含班级选择） ======
app.post('/api/login', (req, res) => {
    const { name, class: studentClass } = req.body;
    if (!name || name.trim().length < 1) return res.status(400).json({ error: '请输入姓名' });
    if (!studentClass || !CLASSES.includes(studentClass)) return res.status(400).json({ error: '请选择班级' });
    req.session.loggedIn = true;
    req.session.name = name.trim();
    req.session.studentClass = studentClass;
    req.session.role = 'student';
    req.session.openid = 'student_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    res.json({ success: true, name: name.trim(), class: studentClass });
});

// ====== 教师登录 ======
app.post('/api/teacher/login', (req, res) => {
    const { username, password } = req.body;
    if (username === CONFIG.teacher.username && password === CONFIG.teacher.password) {
        req.session.teacherLoggedIn = true;
        req.session.role = 'teacher';
        return res.json({ success: true, classes: CLASSES });
    }
    res.status(401).json({ error: '账号或密码错误' });
});

app.post('/api/teacher/logout', (req, res) => {
    req.session.teacherLoggedIn = false;
    res.json({ success: true });
});

function requireTeacher(req, res, next) {
    if (req.session.teacherLoggedIn) return next();
    res.status(401).json({ error: '请先登录教师账号' });
}

// ====== 获取班级列表 ======
app.get('/api/classes', (req, res) => {
    res.json(CLASSES);
});

// ====== 获取题目 ======
app.get('/api/questions', (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: '请先登录' });
    const active = getActiveQuestions();
    if (active.length < CONFIG.quiz.perQuiz) return res.status(500).json({ error: `题库不足，当前${active.length}题` });
    const category = req.query.category || '';
    const questions = getRandomQuestions(CONFIG.quiz.perQuiz, category);
    req.session.questions = questions;
    req.session.startTime = Date.now();
    res.json({ questions, config: CONFIG.quiz, name: req.session.name, class: req.session.studentClass, category: category || '全部' });
});

// ====== 提交答卷 ======
app.post('/api/submit', (req, res) => {
    if (!req.session.loggedIn || !req.session.questions) return res.status(401).json({ error: '会话过期' });
    const { answers } = req.body;
    const sessionQuestions = req.session.questions;
    let correctCount = 0;
    const results = sessionQuestions.map(q => {
        const studentAnswer = (answers[q.id] || '').toUpperCase();
        const fullQ = questionBank.find(bq => bq.id === q.id);
        const correctAnswer = fullQ ? fullQ.answer : '';
        const isCorrect = studentAnswer === correctAnswer;
        if (isCorrect) correctCount++;
        return {
            id: q.id, question: q.question, options: q.options,
            studentAnswer, correctAnswer, isCorrect,
            category: fullQ ? fullQ.category : '',
            explanation: fullQ && fullQ.explanation ? fullQ.explanation : ''
        };
    });
    const score = correctCount * CONFIG.quiz.pointsPerQuestion;
    const totalTime = Math.round((Date.now() - req.session.startTime) / 1000);

    // 知识薄弱点分析
    const catPerf = {};
    results.forEach(r => {
        if (!catPerf[r.category]) catPerf[r.category] = { correct: 0, total: 0 };
        catPerf[r.category].total++;
        if (r.isCorrect) catPerf[r.category].correct++;
    });
    const weakness = Object.entries(catPerf)
        .filter(([,v]) => v.total > 0 && v.correct / v.total < 0.6)
        .map(([k,v]) => ({ category: k, rate: Math.round(v.correct/v.total*100), total: v.total, correct: v.correct }))
        .sort((a,b) => a.rate - b.rate);

    const record = {
        name: req.session.name,
        class: req.session.studentClass,
        openid: req.session.openid,
        score, correct: correctCount, total: sessionQuestions.length,
        percentage: Math.round(correctCount / sessionQuestions.length * 100),
        timeUsed: totalTime, date: new Date().toISOString(),
        weakness, results
    };
    saveRecord(record);
    req.session.questions = null;
    res.json({
        score, correct: correctCount, total: sessionQuestions.length,
        percentage: record.percentage, timeUsed: totalTime,
        passed: score >= CONFIG.quiz.totalScore * 0.6, weakness, results
    });
});

// ====== 学生历史记录 ======
app.get('/api/student/history', (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: '请先登录' });
    const scores = loadScores();
    const history = scores.filter(s => s.name === req.session.name && s.class === req.session.studentClass)
        .map(s => ({ score: s.score, correct: s.correct, total: s.total, percentage: s.percentage,
            timeUsed: s.timeUsed, date: s.date.split('T')[0], weakness: s.weakness }));
    const avg = history.length > 0 ? Math.round(history.reduce((a,b)=>a+b.percentage,0)/history.length) : 0;
    const best = history.length > 0 ? Math.max(...history.map(h=>h.percentage)) : 0;
    res.json({ name: req.session.name, class: req.session.studentClass, totalExams: history.length,
        avgPercentage: avg, bestPercentage: best, history });
});

// ====== 排行榜（含班级筛选） ======
app.get('/api/leaderboard', (req, res) => {
    const classFilter = req.query.class || '';
    const scores = loadScores();
    const filtered = classFilter ? scores.filter(s => s.class === classFilter) : scores;
    const bestMap = {};
    filtered.forEach(s => {
        const key = s.name + '|' + (s.class || '');
        if (!bestMap[key] || bestMap[key].percentage < s.percentage) bestMap[key] = s;
    });
    const leaderboard = Object.values(bestMap)
        .sort((a,b) => b.percentage - a.percentage || a.timeUsed - b.timeUsed)
        .slice(0, 50).map((s,i) => ({
            rank: i+1, name: s.name, class: s.class || '', score: s.score,
            percentage: s.percentage, timeUsed: s.timeUsed, date: s.date.split('T')[0]
        }));
    res.json(leaderboard);
});

// ====== 教师：成绩列表（按班级筛选） ======
app.get('/api/scores', requireTeacher, (req, res) => {
    const classFilter = req.query.class || '';
    let scores = loadScores();
    if (classFilter) scores = scores.filter(s => s.class === classFilter);
    res.json(scores.map(s => ({
        name: s.name, class: s.class || '', score: s.score, correct: s.correct, total: s.total,
        percentage: s.percentage, timeUsed: s.timeUsed, date: s.date.split('T')[0], weakness: s.weakness
    })));
});

// ====== 教师：单个学生详情 ======
app.get('/api/teacher/student-detail', requireTeacher, (req, res) => {
    const { name, class: cls } = req.query;
    if (!name) return res.status(400).json({ error: '缺少姓名' });

    const scores = loadScores();
    const records = loadDetailedRecords();

    // 筛选该学生所有记录
    const studentScores = scores
        .filter(s => s.name === name && (!cls || s.class === cls))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    const studentRecords = records
        .filter(r => r.name === name && (!cls || r.class === cls))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!studentScores.length) return res.json({ found: false });

    // 成绩趋势
    const trend = studentScores.slice().reverse().map(s => ({
        date: s.date.split('T')[0],
        score: s.score,
        percentage: s.percentage
    }));

    // 汇总统计
    const avgPct = Math.round(studentScores.reduce((a, b) => a + b.percentage, 0) / studentScores.length);
    const bestPct = Math.max(...studentScores.map(s => s.percentage));
    const worstPct = Math.min(...studentScores.map(s => s.percentage));
    const improving = studentScores.length >= 2 && studentScores[0].percentage >= studentScores[studentScores.length - 1].percentage;

    // 知识点薄弱分析（跨所有答题）
    const catStats = {};
    studentRecords.forEach(rec => {
        if (rec.results) rec.results.forEach(r => {
            if (!catStats[r.category]) catStats[r.category] = { correct: 0, total: 0 };
            catStats[r.category].total++;
            if (r.isCorrect) catStats[r.category].correct++;
        });
    });
    const weakness = Object.entries(catStats)
        .map(([k, v]) => ({ category: k, total: v.total, accuracy: Math.round(v.correct / v.total * 100) }))
        .sort((a, b) => a.accuracy - b.accuracy);

    // 最近一次答题的详细结果
    const latestRecord = studentRecords[0];
    const latestResults = latestRecord && latestRecord.results ? latestRecord.results.map(r => ({
        question: r.question,
        studentAnswer: r.studentAnswer,
        correctAnswer: r.correctAnswer,
        isCorrect: r.isCorrect,
        category: r.category,
        explanation: r.explanation || ''
    })) : [];

    // 常错题目
    const mistakeCount = {};
    studentRecords.forEach(rec => {
        if (rec.results) rec.results.forEach(r => {
            if (!r.isCorrect) {
                if (!mistakeCount[r.id]) mistakeCount[r.id] = { count: 0, question: r.question, category: r.category };
                mistakeCount[r.id].count++;
            }
        });
    });
    const frequentMistakes = Object.values(mistakeCount)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    res.json({
        found: true,
        name,
        class: studentScores[0].class || '',
        totalExams: studentScores.length,
        avgPercentage: avgPct,
        bestPercentage: bestPct,
        worstPercentage: worstPct,
        improving,
        trend,
        weakness,
        recentExams: studentScores.slice(0, 10).map(s => ({
            date: s.date.split('T')[0],
            score: s.score,
            correct: s.correct,
            total: s.total,
            percentage: s.percentage,
            timeUsed: s.timeUsed,
            weakness: s.weakness || []
        })),
        latestResults,
        frequentMistakes
    });
});

// ====== 教师：班级对比统计 ======
app.get('/api/stats/class-compare', requireTeacher, (req, res) => {
    const scores = loadScores();
    const classStats = {};
    CLASSES.forEach(c => { classStats[c] = { exams: 0, totalScore: 0, students: new Set() }; });
    scores.forEach(s => {
        if (classStats[s.class]) {
            classStats[s.class].exams++;
            classStats[s.class].totalScore += s.percentage;
            classStats[s.class].students.add(s.name);
        }
    });
    const result = CLASSES.map(c => ({
        name: c,
        exams: classStats[c].exams,
        students: classStats[c].students.size,
        avgScore: classStats[c].exams > 0 ? Math.round(classStats[c].totalScore / classStats[c].exams) : 0
    }));
    res.json(result);
});

// ====== 导出CSV ======
app.get('/api/scores/export', requireTeacher, (req, res) => {
    const classFilter = req.query.class || '';
    let scores = loadScores();
    if (classFilter) scores = scores.filter(s => s.class === classFilter);
    let csv = '﻿姓名,班级,分数,正确数,总题数,正确率,用时(秒),日期,薄弱知识点\n';
    scores.forEach(s => {
        const weak = s.weakness ? s.weakness.map(w => `${w.category}(${w.rate}%)`).join(';') : '';
        csv += `${s.name},${s.class||''},${s.score},${s.correct},${s.total},${s.percentage}%,${s.timeUsed},${s.date.split('T')[0]},${weak}\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=quiz-scores-${classFilter||'all'}.csv`);
    res.send(csv);
});

// ====== 题目错误率统计 ======
app.get('/api/stats/questions', requireTeacher, (req, res) => {
    const records = loadDetailedRecords();
    const qStats = {};
    records.forEach(rec => {
        if (rec.results) rec.results.forEach(r => {
            if (!qStats[r.id]) qStats[r.id] = { correct: 0, total: 0, question: r.question, category: r.category };
            qStats[r.id].total++;
            if (r.isCorrect) qStats[r.id].correct++;
        });
    });
    const stats = Object.entries(qStats).map(([id, d]) => ({
        id: parseInt(id), question: d.question.substring(0, 60) + (d.question.length>60?'...':''),
        category: d.category, total: d.total,
        errorRate: Math.round((1 - d.correct/d.total)*100)
    })).sort((a,b) => b.errorRate - a.errorRate).slice(0, 30);
    res.json(stats);
});

// ====== 分类正确率统计 ======
app.get('/api/stats/categories', requireTeacher, (req, res) => {
    const records = loadDetailedRecords();
    const catStats = {};
    records.forEach(rec => {
        if (rec.results) rec.results.forEach(r => {
            if (!catStats[r.category]) catStats[r.category] = { correct: 0, total: 0 };
            catStats[r.category].total++;
            if (r.isCorrect) catStats[r.category].correct++;
        });
    });
    res.json(Object.entries(catStats).map(([name,d]) => ({
        name, total: d.total, accuracy: Math.round(d.correct/d.total*100)
    })).sort((a,b) => a.accuracy - b.accuracy));
});

// ====== 概览统计 ======
// ====== 分类题库 ======
app.get('/api/categories', (req, res) => {
    const active = getActiveQuestions();
    const cats = {};
    active.forEach(q => { cats[q.category] = (cats[q.category] || 0) + 1; });
    const list = Object.entries(cats).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    res.json(list);
});

app.get('/api/stats', (req, res) => {
    const active = getActiveQuestions(); const draft = questionBank.filter(q => q.status === 'draft');
    const categories = {}; active.forEach(q => { categories[q.category] = (categories[q.category]||0)+1; });
    const scores = loadScores();
    const totalExams = scores.length;
    const avgScore = totalExams>0 ? Math.round(scores.reduce((a,b)=>a+b.percentage,0)/totalExams) : 0;
    const uniqueStudents = new Set(scores.map(s => s.name+'|'+s.class)).size;
    const passCount = scores.filter(s => s.percentage>=60).length;
    res.json({ total: questionBank.length, active: active.length, draft: draft.length, categories,
        totalExams, avgScore, uniqueStudents,
        passRate: totalExams>0 ? Math.round(passCount/totalExams*100) : 0 });
});

// ====== 清空 ======
app.delete('/api/scores', requireTeacher, (req, res) => {
    ['scores.json','records.json'].forEach(f => {
        const p = path.join(__dirname, 'data', f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    res.json({ success: true });
});

// ====== 考试模式：教师创建考试 ======
app.post('/api/teacher/create-exam', requireTeacher, (req, res) => {
    const { category, count } = req.body;
    const questionCount = Math.min(parseInt(count) || CONFIG.quiz.perQuiz, 50);
    const code = generateExamCode();
    const questions = getRandomQuestions(questionCount, category || '');
    examSessions[code] = {
        code,
        questions,
        students: {},
        createdAt: Date.now(),
        questionCount: questions.length,
        totalScore: questions.length * CONFIG.quiz.pointsPerQuestion,
        pointsPerQuestion: CONFIG.quiz.pointsPerQuestion,
        category: category || '全部'
    };
    console.log(`考试创建: ${code} | ${questions.length}题 | ${category || '全部'}`);
    res.json({
        code,
        questionCount: questions.length,
        totalScore: questions.length * CONFIG.quiz.pointsPerQuestion,
        link: `/exam?code=${code}`,
        category: category || '全部'
    });
});

// ====== 考试模式：教师查看考试列表 ======
app.get('/api/teacher/exam-sessions', requireTeacher, (req, res) => {
    const list = Object.values(examSessions).map(s => ({
        code: s.code,
        studentCount: Object.keys(s.students).length,
        questionCount: s.questionCount,
        createdAt: new Date(s.createdAt).toISOString(),
        link: `/exam?code=${s.code}`
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(list);
});

// ====== 考试模式：教师查看某场考试结果 ======
app.get('/api/teacher/exam-results/:code', requireTeacher, (req, res) => {
    const session = examSessions[req.params.code];
    if (!session) return res.status(404).json({ error: '考试不存在或已过期' });
    const students = Object.entries(session.students).map(([name, data]) => ({
        name,
        class: data.class,
        score: data.score,
        correct: data.correct,
        total: session.questionCount,
        percentage: data.percentage,
        timeUsed: data.timeUsed,
        submitted: !!data.submittedAt,
        date: data.submittedAt ? new Date(data.submittedAt).toISOString() : ''
    })).sort((a, b) => {
        if (a.submitted && !b.submitted) return 1;
        if (!a.submitted && b.submitted) return -1;
        return (b.percentage || 0) - (a.percentage || 0);
    });
    res.json({ code, students, questionCount: session.questionCount, totalScore: session.totalScore });
});

// ====== 考试模式：学生加入考试 ======
app.post('/api/student/join-exam', (req, res) => {
    const { code, name, class: studentClass } = req.body;
    if (!code || !name || !studentClass) return res.status(400).json({ error: '缺少信息' });
    const session = examSessions[code.toUpperCase()];
    if (!session) return res.status(404).json({ error: '考试码无效或已过期' });
    const cleanName = name.trim();
    if (session.students[cleanName]) return res.status(400).json({ error: '你已加入过本场考试，不能重复加入' });

    session.students[cleanName] = { class: studentClass, startTime: Date.now(), answers: {}, submittedAt: null };
    req.session.examCode = code.toUpperCase();
    req.session.examName = cleanName;
    req.session.examClass = studentClass;
    req.session.loggedIn = true;
    req.session.name = cleanName;
    req.session.studentClass = studentClass;
    req.session.isExam = true;

    res.json({
        success: true,
        name: cleanName,
        code: code.toUpperCase(),
        questionCount: session.questionCount,
        totalScore: session.totalScore,
        timeLimit: CONFIG.quiz.timeLimit
    });
});

// ====== 考试模式：获取考题 ======
app.get('/api/exam/questions', (req, res) => {
    if (!req.session.isExam || !req.session.examCode) return res.status(401).json({ error: '请先加入考试' });
    const session = examSessions[req.session.examCode];
    if (!session) return res.status(404).json({ error: '考试已过期' });
    res.json({
        questions: session.questions.map(({ id, question, options, category }) => ({ id, question, options, category })),
        config: { timeLimit: CONFIG.quiz.timeLimit, pointsPerQuestion: CONFIG.quiz.pointsPerQuestion, totalScore: CONFIG.quiz.totalScore },
        name: req.session.examName,
        code: req.session.examCode
    });
});

// ====== 考试模式：提交答卷 ======
app.post('/api/exam/submit', (req, res) => {
    if (!req.session.isExam || !req.session.examCode) return res.status(401).json({ error: '请先加入考试' });
    const session = examSessions[req.session.examCode];
    if (!session) return res.status(404).json({ error: '考试已过期' });

    const student = session.students[req.session.examName];
    if (!student) return res.status(404).json({ error: '考生信息丢失' });
    if (student.submittedAt) return res.status(400).json({ error: '你已提交过本场考试' });

    const { answers } = req.body;
    let correctCount = 0;
    const results = session.questions.map(q => {
        const studentAnswer = (answers[q.id] || '').toUpperCase();
        const fullQ = questionBank.find(bq => bq.id === q.id);
        const correctAnswer = fullQ ? fullQ.answer : '';
        const isCorrect = studentAnswer === correctAnswer;
        if (isCorrect) correctCount++;
        return {
            id: q.id, question: q.question, options: q.options,
            studentAnswer, correctAnswer, isCorrect,
            category: fullQ ? fullQ.category : '',
            explanation: fullQ && fullQ.explanation ? fullQ.explanation : ''
        };
    });

    const score = correctCount * CONFIG.quiz.pointsPerQuestion;
    const totalTime = Math.round((Date.now() - student.startTime) / 1000);

    // 更新考生记录
    student.answers = req.body.answers;
    student.score = score;
    student.correct = correctCount;
    student.total = session.questionCount;
    student.percentage = Math.round(correctCount / session.questionCount * 100);
    student.timeUsed = totalTime;
    student.submittedAt = Date.now();
    student.results = results;

    // 保存到全局成绩
    const record = {
        name: req.session.examName,
        class: req.session.examClass,
        openid: `exam_${req.session.examCode}_${req.session.examName}`,
        score, correct: correctCount, total: session.questionCount,
        percentage: student.percentage,
        timeUsed: totalTime,
        date: new Date().toISOString(),
        examCode: req.session.examCode,
        weakness: [],
        results
    };
    saveRecord(record);

    res.json({
        score, correct: correctCount, total: session.questionCount,
        percentage: student.percentage, timeUsed: totalTime,
        passed: score >= CONFIG.quiz.totalScore * 0.6,
        weakness: record.weakness,
        results
    });
});

// ====== 页面路由 ======
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ====== 数据存取 ======
function saveRecord(record) {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 成绩摘要
    const sFile = path.join(dir, 'scores.json');
    let scores = [];
    try { scores = JSON.parse(fs.readFileSync(sFile, 'utf-8')); } catch(e) {}
    const { results, ...simple } = record;
    scores.push(simple);
    if (scores.length > 2000) scores = scores.slice(-2000);
    fs.writeFileSync(sFile, JSON.stringify(scores, null, 2), 'utf-8');

    // 详细记录
    const rFile = path.join(dir, 'records.json');
    let records = [];
    try { records = JSON.parse(fs.readFileSync(rFile, 'utf-8')); } catch(e) {}
    records.push(record);
    if (records.length > 500) records = records.slice(-500);
    fs.writeFileSync(rFile, JSON.stringify(records, null, 2), 'utf-8');
}

function loadScores() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname,'data','scores.json'),'utf-8')); }
    catch(e) { return []; }
}
function loadDetailedRecords() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname,'data','records.json'),'utf-8')); }
    catch(e) { return []; }
}

// ====== 启动 ======
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════');
    console.log('  动物药理在线答题系统 v3.0');
    console.log(`  学生答题: http://localhost:${PORT}`);
    console.log(`  教师管理: http://localhost:${PORT}/admin`);
    console.log(`  题库: ${questionBank.length}题 | 可用: ${getActiveQuestions().length}题`);
    console.log(`  班级: ${CLASSES.length}个 | 教师: ${CONFIG.teacher.username}`);
    console.log('═══════════════════════════════════════');
});
