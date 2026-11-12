import styles from './lens.module.css';

export default function Rim() {
  return (
    <div aria-hidden="true" className={styles.rim}>
      <span className={`${styles.tick} ${styles.tickTop}`} />
      <span className={`${styles.tick} ${styles.tickRight}`} />
      <span className={`${styles.tick} ${styles.tickBottom}`} />
      <span className={`${styles.tick} ${styles.tickLeft}`} />
      <span className={styles.label}>KAAP READS IT</span>
    </div>
  );
}
