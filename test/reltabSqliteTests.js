/* @flow */

import db from 'sqlite'
import test from 'tape'
import * as reltab from '../src/reltab'
import * as reltabSqlite from '../src/reltab-sqlite'
import * as csvimport from '../src/csvimport'
import * as util from './reltabTestUtils'

const {col, constVal} = reltab

var sharedRtc
const testPath = 'csv/bart-comp-all.csv'

const q1 = reltab.tableQuery('bart-comp-all')

var tcoeSum

const dbTest0 = () => {
  test('basic table query', t => {
    const rtc = sharedRtc // Note: need to ensure we only read sharedRtc inside test()
    console.log('dbTest0: test start: ', rtc)
    rtc.evalQuery(q1)
    .then(res => {
      t.ok(true, 'basic table read')
      var schema = res.schema
      var expectedCols = ['Name', 'Title', 'Base', 'OT', 'Other', 'MDV', 'ER',
                        'EE', 'DC', 'Misc', 'TCOE', 'Source', 'JobFamily', 'Union']

      const columns = schema.columns // array of strings
      // console.log('columns: ', columns)

      t.deepEqual(columns, expectedCols, 'getSchema column ids')

      const columnTypes = columns.map(colId => schema.columnType(colId))
      var expectedColTypes = ['text', 'text', 'integer', 'integer', 'integer',
        'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'text', 'text', 'text']

      t.deepEqual(columnTypes, expectedColTypes, 'getSchema column types')

      const rowData = res.rowData
      t.equal(rowData.length, 2873, 'q1 rowData.length')

      // console.log(rowData[0])
      var expRow0 = ['Crunican, Grace', 'General Manager', 312461, 0, 3846, 19141, 37513,
        17500, 1869, 7591, 399921, 'MNP', 'Executive Management', 'Non-Represented']
      t.deepEqual(rowData[0], expRow0, 'first row matches expected')

      tcoeSum = util.columnSum(res, 'TCOE')
      console.log('TCOE sum: ', tcoeSum)
      t.end()
    })
  })
}

const pcols = ['JobFamily', 'Title', 'Union', 'Name', 'Base', 'TCOE']
const q2 = q1.project(pcols)

const dbTest2 = () => {
  test('basic project operator', t => {
    const rtc = sharedRtc
    t.plan(3)
    // console.log('q2: ', q2)
    rtc.evalQuery(q2).then(res => {
      t.ok(true, 'project query returned success')
      // console.log('project query schema: ', res.schema)
      t.deepEqual(res.schema.columns, pcols, 'result schema from project')

      // console.log(res.rowData[0])
      var expRow0 = ['Executive Management', 'General Manager', 'Non-Represented', 'Crunican, Grace', 312461, 399921]

      t.deepEqual(res.rowData[0], expRow0, 'project result row 0')
      t.end()
    })
  })
}

const q3 = q1.groupBy(['Job', 'Title'], ['TCOE'])  // note: [ 'TCOE' ] equivalent to [ [ 'sum', 'TCOE' ] ]

const dbTest3 = () => {
  test('basic groupBy', t => {
    const rtc = sharedRtc
    rtc.evalQuery(q3).then(res => {
      // console.log('groupBy result: ', res)

      const expCols = ['Job', 'Title', 'TCOE']
      t.deepEqual(res.schema.columns, expCols, 'groupBy query schema')

      t.deepEqual(res.rowData.length, 380, 'correct number of grouped rows')

      const groupSum = util.columnSum(res, 'TCOE')
      t.equal(groupSum, tcoeSum, 'grouped TCOE sum matches raw sum')
      t.end()
    })
  })
}

const q4 = q2.groupBy(['JobFamily'], ['Title', 'Union', 'Name', 'Base', 'TCOE'])

const dbTest4 = () => {
  test('groupBy aggs', t => {
    const rtc = sharedRtc
    rtc.evalQuery(q4).then(res => {
      console.log('group by job family: ')
      util.logTable(res)

      var rs = res.schema

      const expCols = ['JobFamily', 'Title', 'Union', 'Name', 'Base', 'TCOE']
      t.deepEqual(rs.columns, expCols)

      t.deepEqual(res.rowData.length, 19, 'number of grouped rows in q4 result')

      const groupSum = util.columnSum(res, 'TCOE')
      t.deepEqual(groupSum, tcoeSum, 'tcoe sum after groupBy')
      t.end()
    }, util.mkAsyncErrHandler(t, 'evalQuery q4'))
  })
}

const sqliteQueryTest = (label: string, query: reltab.QueryExp,
                          cf: (t: any, res: reltab.TableRep) => void): void => {
  test(label, t => {
    const rtc = sharedRtc
    rtc.evalQuery(query).then(res => cf(t, res), util.mkAsyncErrHandler(t, label))
  })
}

const q5 = q1.filter(reltab.and().eq(col('JobFamily'), constVal('Executive Management')))

const dbTest5 = () => {
  sqliteQueryTest('basic filter', q5, (t, res) => {
    t.ok(res.rowData.length === 14, 'expected row count after filter')
    util.logTable(res)
    t.end()
  })
}

const sqliteTestSetup = () => {
  test('sqlite test setup', t => {
    db.open(':memory:')
      .then(() => csvimport.importSqlite(testPath))
      .then(md => reltabSqlite.init(db, md))
      .then(rtc => {
        sharedRtc = rtc
        console.log('set rtc: ', sharedRtc)
        t.ok(true, 'setup and import complete')
        t.end()
      })
      .catch(err => console.error('sqliteTestSetup failure: ', err, err.stack))
  })
}

const sqliteTestShutdown = () => {
  test('sqlite test setup', t => {
    db.close()
      .then(() => {
        t.ok(true, 'finished db.close')
        t.end()
      })
  })
}
const runTests = () => {
  sqliteTestSetup()
  dbTest0()
  dbTest2()
  dbTest3()
  dbTest4()
  dbTest5()
  sqliteTestShutdown()
}

runTests()
