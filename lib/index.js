const fs = require('fs-extra')
const path = require('path')
const moment = require('moment')
const { range } = require('range')

const NUL = 0x0
const DC4 = 0x14
const NAK = 0x15

const EDF_ANNOTATIONS_LABEL = 'EDF Annotations'
const TALS_DELIMITER = Buffer.from([DC4, NUL])
const ANNOTATIONS_DELIMITER = Buffer.from([DC4])
const ONESET_DELIMITER = Buffer.from([NAK])

const NUMBER = function (v) {
    return +STRING(v)
}

const STRING = function (v) {
    return v.toString().trim()
}

const NUMBER_OF_PER_HEADER_BYTES = 256
const SAMPLE_BYTE_LENGTH = 2

const EDF_SPECIFICATION = {
    HEADERS: [
        { name: 'version', len: 8, desc: 'EDF文件版本号', type: NUMBER },
        { name: 'patient_id', len: 80, desc: '被测者唯一标识', type: STRING },
        { name: 'record_id', len: 80, desc: '此次记录id', type: STRING },
        { name: 'start_date', len: 8, desc: '记录开始日期dd.mm.yy', type: STRING },
        { name: 'start_time', len: 8, desc: '记录开始时间hh.mm.ss', type: STRING },
        { name: 'number_of_bytes_in_header', len: 8, desc: '头部的字节总长度，包括文件头和信号头', type: NUMBER },
        { name: 'reserved', len: 44, desc: 'EDF文件版本号', type: STRING },
        { name: 'number_of_blocks_in_record', len: 8, desc: '文件中的块总数', type: NUMBER },
        { name: 'duration_of_data_record', len: 8, desc: '数据块多少秒记录一次', type: NUMBER },
        { name: 'number_of_signals', len: 4, desc: '文件中的信号数量', type: NUMBER },
    ],
    SIGNAL_HEADERS: [
        { name: 'label', len: 16, desc: '标签 电极位置，体温等信息', type: STRING },
        { name: 'transducer', len: 80, desc: '电极信息', type: STRING },
        { name: 'physical_dimension', len: 8, desc: '幅值单位信息', type: STRING },
        { name: 'physical_min', len: 8, desc: '物理信号最小值', type: NUMBER },
        { name: 'physical_max', len: 8, desc: '物理信号最大值', type: NUMBER },
        { name: 'digital_min', len: 8, desc: '数字信号最小值', type: NUMBER },
        { name: 'digital_max', len: 8, desc: '数字信号最大值', type: NUMBER },
        { name: 'prefiltering', len: 80, desc: '滤波器参数', type: STRING },
        { name: 'number_of_samples', len: 8, desc: '采样率', type: NUMBER },
        { name: 'reserved', len: 32, desc: '保留字段 (采集信号类型)', type: STRING },
    ]
}

class Edflib {

    constructor(file_path) {
        this.edf = { headers: {}, signals: [] }
        this.file_path = file_path
    }

    async parse_headers() {
        let header_bytes = Buffer.alloc(NUMBER_OF_PER_HEADER_BYTES)
        await fs.read(this.fd, header_bytes, 0, NUMBER_OF_PER_HEADER_BYTES, 0)
        let next = 0
        EDF_SPECIFICATION.HEADERS.forEach(({ name, len, type }) => {
            this.edf.headers[name] = type(header_bytes.slice(next, next + len))
            next += len
        })
        this.edf.start_datetime = moment(`${this.edf.headers.start_date}${this.edf.headers.start_time}`, 'DD.MM.YYHH.mm.ss').toDate()
        this.edf.start_datetime_formatted = moment(this.edf.start_datetime).format('YYYY-MM-DD HH:mm:ss')
    }

    async parse_signals_headers() {
        let number_of_skip_header_bytes = NUMBER_OF_PER_HEADER_BYTES
        let len_of_signal_headers = this.edf.headers.number_of_signals * NUMBER_OF_PER_HEADER_BYTES
        let signals_header_bytes = Buffer.alloc(len_of_signal_headers)
        await fs.read(this.fd, signals_header_bytes, 0, len_of_signal_headers, number_of_skip_header_bytes)
        range(0, this.edf.headers.number_of_signals).forEach(() => {
            this.edf.signals.push({
                headers: {},
                data: []
            })
        })
        let next = 0
        EDF_SPECIFICATION.SIGNAL_HEADERS.forEach(({ name, len, type }) => {
            this.edf.signals.forEach((signal) => {
                signal.headers[name] = type(signals_header_bytes.slice(next, next + len))
                next += len
            })
        })
        this.edf.signals.forEach((signal) => {
            signal.sample_duration = this.edf.headers.duration_of_data_record / signal.headers.number_of_samples;
            signal.sample_rate = signal.headers.number_of_samples / this.edf.headers.duration_of_data_record;
            signal.bytes_in_data_record = signal.headers.number_of_samples * SAMPLE_BYTE_LENGTH;
        })
        this.edf.num_samples_in_data_record = 0
        this.edf.bytes_in_data_record = 0
        this.edf.signals.forEach(signal => {
            this.edf.num_samples_in_data_record += signal.headers.number_of_samples
            this.edf.bytes_in_data_record += signal.bytes_in_data_record
        })
    }

    splitBuffer(buffer, delimiter) {
        const lines = [];
        let search;
        while ((search = buffer.indexOf(delimiter)) > -1) {
            lines.push(buffer.slice(0, search));
            buffer = buffer.slice(search + delimiter.length, buffer.length);
        }
        buffer.length && lines.push(buffer);
        return lines;
    }


    async parse() {
        this.fd = await fs.open(this.file_path, 'r')
        await this.parse_headers()
        await this.parse_signals_headers()
    }

    parse_annotation(signal, block) {
        const tals = this.splitBuffer(block, TALS_DELIMITER);
        tals.forEach(tal => {
            if (tal.indexOf(DC4) < 0) {
                return;
            }
            const [onset, ...rawAnnotations] = this.splitBuffer(tal, ANNOTATIONS_DELIMITER);
            const [rawStart, rawDuration = Buffer.from([NUL])] = this.splitBuffer(onset, ONESET_DELIMITER);
            const start = rawStart.toString()
            const duration = rawDuration.toString()
            rawAnnotations.forEach(rawAnnotation => {
                signal.data.push({
                    start: start,
                    value: rawAnnotation.toString().trim(),
                    duration
                })
            });
        });
    }

    async parse_block() {
        let position = this.edf.headers.number_of_bytes_in_header
        for (let i = 0; i < this.edf.headers.number_of_blocks_in_record; i++) {
            let block_bytes = Buffer.alloc(this.edf.bytes_in_data_record)
            let start = 0
            await fs.read(this.fd, block_bytes, 0, this.edf.bytes_in_data_record, position)
            for (let j = 0; j < this.edf.signals.length; j++) {
                let signal = this.edf.signals[j]
                let block = block_bytes.slice(start, start + signal.bytes_in_data_record)
                if (signal.headers.label === EDF_ANNOTATIONS_LABEL) {
                    this.parse_annotation(signal, block)
                } else {
                    let offset = 0
                    for (let k = 0; k < signal.headers.number_of_samples; k++) {
                        const value = block.readInt16LE(offset)
                        signal.data.push(value)
                        offset += SAMPLE_BYTE_LENGTH
                    }
                }
                start += signal.bytes_in_data_record
            }
            position += this.edf.bytes_in_data_record
        }
    }
}

module.exports = Edflib

async function test() {
    console.time('edf')
    let file_path = path.join(__dirname, '..', 'samples', 'sample2.edf')
    let edflib = new Edflib(file_path)
    await edflib.parse()
    await edflib.parse_block()
    console.timeEnd('edf')
    console.log(edflib.edf.signals[edflib.edf.signals.length - 1])
}

test()