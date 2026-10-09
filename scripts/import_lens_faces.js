#!/usr/bin/env node
/**
 * One-off: import the faces exported from the old face kiosk
 * (BOTLens-updated/backend/export_faces.py) into FaceProfile.
 *
 *   node scripts/import_lens_faces.js <faces.json>           # dry run: report only, writes nothing
 *   node scripts/import_lens_faces.js <faces.json> --apply   # write
 *
 * Each face is checked before anything is written: the company exists and is
 * not kept on the previous release, the employee exists, is an active employee
 * of THAT company, and has no face registered yet (an existing one is never
 * overwritten). The thumbnail goes to Cloudinary (lens/faces) on --apply only.
 * Reads MONGO_URI from .env like every script here.
 */
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const FaceProfile = require('../src/models/FaceProfile');
const { isFrozenTenant } = require('../src/utils/frozen_tenants');
const { cloudinary } = require('../src/config/cloudinary');

const file = process.argv[2];
const apply = process.argv.includes('--apply');

(async () => {
    if (!file || !fs.existsSync(file)) {
        console.log('usage: node scripts/import_lens_faces.js <faces.json> [--apply]');
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    await mongoose.connect(process.env.MONGO_URI);
    const seen = new Set();
    const report = [];
    let written = 0;

    for (const f of data.faces || []) {
        const line = { kioskName: f.kioskName, scans: (f.embeddings || []).length };
        const valid = mongoose.isValidObjectId(f.adminId) && mongoose.isValidObjectId(f.employeeId);
        const admin = valid ? await User.findOne({ _id: f.adminId, role: 'admin' }).select('companyName name').lean() : null;
        const emp = valid ? await User.findById(f.employeeId).select('name role adminId status').lean() : null;
        line.company = admin ? (admin.companyName || admin.name) : '(no such company)';
        line.employee = emp ? emp.name : '(no such employee)';

        let verdict = 'import';
        if (!admin) verdict = 'skip: company not found';
        else if (isFrozenTenant(f.adminId)) verdict = 'skip: company kept on the previous release';
        else if (!emp || emp.role !== 'employee') verdict = 'skip: employee not found';
        else if (String(emp.adminId) !== String(f.adminId)) verdict = 'skip: employee belongs to another company';
        else if (emp.status === 'inactive') verdict = 'skip: employee is switched off';
        else if (seen.has(String(f.employeeId))) verdict = 'skip: same employee twice in the export';
        else if (!Array.isArray(f.embeddings) || !f.embeddings.length || f.embeddings.some((v) => !Array.isArray(v) || v.length !== 128)) verdict = 'skip: face data not usable';
        else if (await FaceProfile.exists({ adminId: f.adminId, employeeId: f.employeeId })) verdict = 'skip: already has a face (kept)';
        seen.add(String(f.employeeId));
        line.verdict = verdict;

        if (verdict === 'import' && apply) {
            let thumbnailUrl = null;
            if (f.thumbnail) {
                try {
                    const up = await cloudinary.uploader.upload(f.thumbnail, {
                        folder: 'lens/faces', resource_type: 'image',
                        transformation: [{ width: 240, height: 240, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
                    });
                    thumbnailUrl = up.secure_url;
                } catch (e) {
                    line.note = `thumbnail not uploaded: ${e.message}`;
                }
            }
            await FaceProfile.create({
                adminId: f.adminId, employeeId: f.employeeId, embeddings: f.embeddings.slice(0, 12),
                modelVersion: data.model || 'sface_2021dec', thumbnailUrl,
            });
            written++;
        }
        report.push(line);
    }

    console.table(report);
    for (const s of data.skipped || []) console.log(`not exported: ${s.name} (${s.reason})`);
    const toImport = report.filter((r) => r.verdict === 'import').length;
    console.log(apply ? `\nwritten: ${written} faces` : `\nDRY RUN: ${toImport} would be imported, ${report.length - toImport} skipped. Nothing written.`);
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('ERROR', e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
