import * as duckdb from 'node-duckdb';
import * as reltab from "reltab";
import * as reltabDuckDB from "../src/reltab-duckdb";
import * as tp from "typed-promisify";
import { textSpanContainsPosition } from "typescript";
import { delimiter } from "path";
import * as log from "loglevel";
import * as util from "./testUtils";
import * as _ from "lodash";
import { asString } from "reltab";

const { col, constVal } = reltab;

const coreTypes = reltab.SQLiteDialect.coreColumnTypes;

let testCtx: reltabDuckDB.DuckDBContext;

const q1 = reltab.tableQuery("barttest");

test("t0 - trivial query generation", () => {
  expect(q1).toMatchInlineSnapshot(`
    QueryExp {
      "_rep": Object {
        "operator": "table",
        "tableName": "barttest",
      },
      "expType": "QueryExp",
    }
  `);
});

const importCsv = async (dbConn: duckdb.Connection, path: string) => {
/*
  const md = await reltabDuckDB.fastImport(dbConn, path);

  const ti = reltabDuckDB.mkTableInfo(md);
  testCtx.registerTable(ti);
  // console.log("importCsv: table info: ", JSON.stringify(ti, null, 2));
*/
  await reltabDuckDB.nativeCSVImport(dbConn, path);
};

beforeAll(
  async (): Promise<reltabDuckDB.DuckDBContext> => {
    log.setLevel("debug"); // use "debug" for even more verbosity
    const ctx = await reltab.getConnection({
      providerName: "duckdb",
      connectionInfo: ":memory:",
    });

    testCtx = ctx as reltabDuckDB.DuckDBContext;

    const dbConn = testCtx.dbConn;

    await importCsv(dbConn, "test/support/sample.csv");
    await importCsv(dbConn, "test/support/barttest.csv");

    return testCtx;
  }
);

test("t1 - basic sqlite tableQuery", async () => {
  const q1 = reltab.tableQuery("sample");
  const qres = await testCtx.evalQuery(q1);
  expect(qres).toMatchSnapshot();
});

const bartTableQuery = reltab.tableQuery("barttest");

test("t2 - basic bart table query", async () => {
  const qres = await testCtx.evalQuery(bartTableQuery);

  expect(qres).toMatchSnapshot();
});

test("basic rowcount", async () => {
  const rowCount = await testCtx.rowCount(bartTableQuery);

  expect(rowCount).toBe(23);
});

const pcols = ["Job Family", "Title", "Union", "Name", "Base", "TCOE"];
const q2 = bartTableQuery.project(pcols);

test("basic project operator", async () => {
  const qres = await testCtx.evalQuery(q2);
  expect(qres.schema.columns).toEqual(pcols);

  expect(qres).toMatchSnapshot();
});

test("table and schema deserialization", async () => {
  const qres = await testCtx.evalQuery(q2);

  /*
  console.log(
    "qres schema, Job Family column type: ",
    qres.schema.columnType("Job Family")
  );
  */
  const qresStr = JSON.stringify(qres, undefined, 2);

  const deserRes = reltab.deserializeTableRepStr(qresStr);

  const jfct = deserRes.schema.columnType("Job Family");
  expect(typeof jfct.stringRender).toBe("function");
});

test("basic groupBy", async () => {
  const q3 = bartTableQuery.groupBy(["Job Family", "Title"], ["TCOE"]); // note: [ 'TCOE' ] equivalent to [ [ 'sum', 'TCOE' ] ]

  // testCtx.showQueries = true;
  const qres = await testCtx.evalQuery(q3);

  const expCols = ["Job Family", "Title", "TCOE"];
  expect(qres.schema.columns).toEqual(expCols);

  expect(qres.rowData.length).toBe(19);

  const baseRes = await testCtx.evalQuery(bartTableQuery);
  const tcoeSum = util.columnSum(baseRes, "TCOE");

  const groupSum = util.columnSum(qres, "TCOE");
  expect(BigInt(groupSum)).toBe(BigInt(tcoeSum));

  expect(qres).toMatchSnapshot();
});

const q5 = bartTableQuery.filter(
  reltab.and().eq(col("Job Family"), constVal("Executive Management"))
);

test("basic filter", async () => {
  const res = await testCtx.evalQuery(q5);
  expect(res.rowData.length).toBe(4);

  expect(res).toMatchSnapshot();
});

test("escaped literal string filter", async () => {
  // Test for literal string with single quote (which must be escaped):
  const q5b = q1.filter(
    reltab
      .and()
      .eq(col("Title"), constVal("Department Manager Gov't & Comm Rel"))
  );

  const res = await testCtx.evalQuery(q5b);

  expect(res.rowData.length).toBe(1);
});

test("empty and filter", async () => {
  const q5c = q1.filter(reltab.and());

  const res = await testCtx.evalQuery(q5c);
  expect(res.rowData.length).toBe(23);
});

test("query deserialization", async () => {
  let req: Object = { query: q5 };
  const ser5 = JSON.stringify(req, null, 2);
  const dq5 = reltab.deserializeQueryReq(ser5);
  const rtc = testCtx;
  const res = await rtc.evalQuery(dq5.query);
  expect(res.rowData.length).toBe(4);
});

const q6 = q1.mapColumns({
  Name: { id: "EmpName", displayName: "Employee Name" },
});

test("mapColumns", async () => {
  const res = await testCtx.evalQuery(q6);
  const rs = res.schema;
  expect(rs.columns[0]).toBe("EmpName");
  const em = rs.columnMetadata["EmpName"];
  expect(em.columnType).toBe("VARCHAR");
  expect(em.displayName).toBe("Employee Name");
  expect(res.rowData.length).toBe(23);
});

const q7 = q1.mapColumnsByIndex({
  0: { id: "EmpName" },
});

test("mapColumnsByIndex", async () => {
  const res = await testCtx.evalQuery(q7);
  const rs = res.schema;
  expect(rs.columns[0]).toBe("EmpName");
  const em = rs.columnMetadata["EmpName"];
  expect(res.rowData.length).toBe(23);
});

const q8 = q5.concat(
  q1.filter(reltab.and().eq(col("Job Family"), constVal("Safety")))
);

test("concat", async () => {
  const res = await testCtx.evalQuery(q8);
  expect(res.rowData.length).toBe(5);
  const jobCol = res.getColumn("Job Family");
  const jobs = _.sortedUniq(jobCol);
  expect(jobs).toEqual(["Executive Management", "Safety"]);
});

const q9 = q8.sort([["Name", true]]);

test("basic sort", async () => {
  const res = await testCtx.evalQuery(q9);
  expect(res).toMatchSnapshot();
});

const q10 = q8.sort([
  ["Job Family", true],
  ["TCOE", false],
]);

test("compound key sort", async () => {
  const res = await testCtx.evalQuery(q10);
  expect(res).toMatchSnapshot();
});

const qex1 = q8.extend("_depth", constVal(0));
test("basic extend with const col", async () => {
  const res = await testCtx.evalQuery(qex1);
  expect(res).toMatchSnapshot();
});

const qex2 = qex1.project(["Name", "Title", "Job Family", "TCOE", "_depth"]);
test("basic extend composed with project", async () => {
  const res = await testCtx.evalQuery(qex2);
  expect(res).toMatchSnapshot();
});

const qex3 = q1
  .extend("_pivot", asString(constVal(null)))
  .extend("_depth", constVal(0));

test("chained extend", async () => {
  // console.log("chained extend: query: ", JSON.stringify(qex3, undefined, 2));
  const res = await testCtx.evalQuery(qex3);
  // util.logTable(res);
  expect(res).toMatchSnapshot();
});

const qex4 = q1.extend("_pivot", asString(constVal(null)));
test("null const extend", async () => {
  const res = await testCtx.evalQuery(qex4);
  // util.logTable(res);
  expect(res).toMatchSnapshot();
});

test("getSourceInfo basics", async () => {
  const rtc = testCtx;
  const rootSourceInfo = await rtc.getSourceInfo([]);
  // console.log("root source info: ", rootSourceInfo);

  /*  
  const covid_item = rootSourceInfo.children.find(
    (item) => item.id === "covid19_jhu_csse"
  );

  console.log("calling getSourceInfo on item ", covid_item);
  const covidSourceInfo = await rtc.getSourceInfo([covid_item!]);
  console.log("covid19 source info: ", covidSourceInfo);
*/
});

/*
 * We'd need to put back expression syntax in extend first:
const q11 = q8.extend('ExtraComp', {type: 'integer'}, col('TCOE - Base'));
const dbTest11 = (htest) => {
  sqliteQueryTest(htest, 'extend with expression', q11, (t, res) => {
    util.logTable(res)
    t.end()
  })
}
*/
