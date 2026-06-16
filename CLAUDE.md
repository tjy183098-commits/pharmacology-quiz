# 动物药理在线答题系统

## 部署
- Render: https://xaveterinarypharmacology.onrender.com
- 教师: /admin (admin/pharma2026)
- GitHub: tjy183098-commits/pharmacology-quiz
- 自动部署: push main → Render

## 架构
- server.js — Express后端 (端口3000)
- index.html — 学生端
- admin.html — 教师端
- questions.json — 题库(500题)
- data/scores.json — 成绩

## 关键约定
- 暗蓝配色: #0D2B4E / #1A3D6B / #3D8CD9
- 风格: 简洁实用，中文教学
- 学生姓名可以是任意名字，班级必须从11个预定义班级中选择
- 考试模式: 教师生成6位码，学生输入码加入，同码同题
