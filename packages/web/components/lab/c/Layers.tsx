import { hashHex, sentence } from '@/lib/labData';
import { buildRows } from './rows';
import styles from './lens.module.css';

// The hash moves on 8 characters per row, the sentence 5. A space ends each copy of the sentence so
// the copies read as separate sentences when they meet.
const WALL_ROWS = buildRows(hashHex, 8);
const TRUTH_ROWS = buildRows(`${sentence} `, 5);

export function Wall() {
  return (
    <div aria-hidden="true" className={`${styles.layer} ${styles.wall}`}>
      {WALL_ROWS.map((row, index) => (
        <div key={index} className={`${styles.wallRow} ${index % 2 === 1 ? styles.wallRowEven : ''}`}>
          {row}
        </div>
      ))}
    </div>
  );
}

export function Truth() {
  return (
    <div aria-hidden="true" className={`${styles.layer} ${styles.truth}`}>
      {TRUTH_ROWS.map((row, index) => (
        <div key={index} className={styles.truthRow}>
          {row}
        </div>
      ))}
    </div>
  );
}
